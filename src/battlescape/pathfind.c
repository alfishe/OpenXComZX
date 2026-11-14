// Поиск пути по клеткам боя (16_battlescape_plan.md §5.4, порт Pathfinding оригинала —
// пока без «больших стен», приседания и полёта). Вынесен в свой банк: экран боя (банк 28)
// уже занимал всю страницу.
//
// Что учитывается: пол под ногами, объект в клетке, стены между клетками, цена прохода
// (MCD.TU_Walk, 255 — не пройти) и переходы между этажами — вверх по ступеням
// (T_Level <= -16) и вниз, если под ногами нет пола. Двери проходимы: боец откроет их
// шагом, как в оригинале (у закрытой двери цена не 255, и isBlocked её не считает преградой).
//
// Волна — Беллман–Форд с очередью: цена шага разная, и найденное первым не всегда дешевле,
// поэтому клетка переоткрывается, если к ней нашли путь дешевле.
//
// Скорость (замеры 2026-09-21, карта 40x40): сперва волна читала карту дальним чтением на
// каждое соседство, и один щелчок думал 165 кадров (3.3 с). Что сделано:
//   - клетки этажа сворачиваются в слепок по байту на клетку (pathfind.h, PC_*), и карта
//     при этом читается рядами — одно far_read на ряд вместо чтения на клетку;
//   - волна идёт в окне вокруг начала и цели (PF_MARGIN); не дошли — второй заход без
//     границ. Почти все щелчки рядом с бойцом, а полная волна на Z80 стоит больше секунды.
// Клетки других этажей (ступени, падение) читаются по месту — это редкость.
#include <stdint.h>
#include <string.h>
#include "pages.h"
#include "far.h"
#include "pathfind.h"

#define PF_W      64
#define PF_MARGIN 6            // запас окна поиска вокруг начала и цели (в клетках)
#define PF_COST(x, y)  (pf[(uint16_t)(y) * PF_W + (x)])
#define PF_FROM(x, y)  (pf[4096 + (uint16_t)(y) * PF_W + (x)])
#define PF_CELL(x, y)  (pf[PF_CACHE + (uint16_t)(y) * PF_W + (x)])

const int8_t pf_dx[8] = { 0, 1, 1, 1, 0, -1, -1, -1 };
const int8_t pf_dy[8] = { -1, -1, 0, 1, 1, 1, 0, -1 };

// Стены между клетками (Pathfinding::isBlocked, направления 0..7, без «больших стен»):
// для каждого направления — свои проверки (dx, dy, слот), слот 1 — западная стена клетки,
// 2 — северная. Смещения от клетки, из которой шагаем.
static const int8_t blk[] = {
	0, 0, 2,                                              // 0 север
	0, 0, 2,   1, -1, 1,   1, 0, 1,   1, 0, 2,            // 1 северо-восток
	1, 0, 1,                                              // 2 восток
	1, 0, 1,   0, 1, 2,    1, 1, 2,   1, 1, 1,            // 3 юго-восток
	0, 1, 2,                                              // 4 юг
	0, 0, 1,   0, 1, 1,    0, 1, 2,   -1, 1, 2,           // 5 юго-запад
	0, 0, 1,                                              // 6 запад
	0, 0, 1,   0, 0, 2,    -1, 0, 2,  0, -1, 1,           // 7 северо-запад
};
static const uint8_t blk_ofs[8] = { 0, 1, 5, 6, 10, 11, 15, 16 };   // в тройках
static const uint8_t blk_n[8] = { 1, 4, 1, 4, 1, 4, 1, 4 };

static far_t pf_cells;
static uint8_t pf_sx, pf_sy, pf_z, pf_step;

// Клетка карты: номер считается в 16 битах и умножается на 4 сдвигом — 32-битное
// умножение здесь обходилось дороже самого чтения.
static void cell_at(uint8_t x, uint8_t y, uint8_t z, uint8_t *c)
{
	uint16_t idx = (uint16_t)(((uint16_t)z * pf_sy + y) * pf_sx + x);
	far_read(pf_cells + ((uint32_t)idx << 2), c, 4);
}

// Четыре части клетки -> байт слепка: цена входа в старшей тетраде, флаги — в младшей
static uint8_t cell_pack(const uint8_t *pf, const uint8_t *c)
{
	uint8_t b = 0;
	if (c[1] && pf[PF_TU + c[1]] == 255) b |= PC_WEST;
	if (c[2] && pf[PF_TU + c[2]] == 255) b |= PC_NORTH;
	int8_t lv = c[0] ? (int8_t)pf[PF_TLEVEL + c[0]] : 0;
	if (c[3]) {
		int8_t o = (int8_t)pf[PF_TLEVEL + c[3]];
		if (o < lv) lv = o;
	}
	if (lv <= -16) b |= PC_STAIRS;
	uint8_t bw = c[3] ? pf[PF_BIGWALL + c[3]] : 0;
	if (bw == BW_WEST || bw == BW_WN) b |= PC_WEST;
	if (bw == BW_NORTH || bw == BW_WN) b |= PC_NORTH;
	if (!c[0] || (pf[PF_FLAGS + c[0]] & 1)) b |= PC_NOFLOOR;
	uint8_t cost = 0;
	if (!(b & PC_NOFLOOR)) {                     // цена входа: пол плюс объект
		uint8_t t = pf[PF_TU + c[0]];
		if (t != 255) {
			// Объект с ценой 255 закрывает клетку; объект с ценой 0 (ступени, сиденья) —
			// нет: до 2026-11-13 он тоже давал 0 и клетка выходила непроходимой. Объект-стена
			// у края клетки (большая стена 4..9) входу не мешает вовсе.
			uint8_t shut = 0;
			cost = t;
			if (c[3] && bw < BW_WEST) {
				uint8_t o = pf[PF_TU + c[3]];
				if (o == 255) shut = 1;
				else cost += o;
			}
			if (shut) cost = 0;
			else {
				if (cost < pf_step) cost = pf_step;
				if (cost > 15) cost = 15;
			}
		}
	}
	return (uint8_t)(b | (cost << 4));
}

// Слепок клетки: свой этаж — из слепка, чужой — читаем карту (ступени и падение)
static uint8_t cell_info(const uint8_t *pf, uint8_t x, uint8_t y, uint8_t z)
{
	if (z == pf_z) return PF_CELL(x, y);
	uint8_t c[4];
	cell_at(x, y, z, c);
	return cell_pack(pf, c);
}

// Стена на пути между клетками: 1 — не пройти
static uint8_t wall_blocked(const uint8_t *pf, uint8_t cx, uint8_t cy, uint8_t cz, uint8_t d)
{
	const int8_t *p = blk + (uint16_t)blk_ofs[d] * 3;
	for (uint8_t i = blk_n[d]; i; i--, p += 3) {
		int16_t x = (int16_t)cx + p[0], y = (int16_t)cy + p[1];
		if (x < 0 || y < 0 || x >= pf_sx || y >= pf_sy) return 1;
		uint8_t b = cell_info(pf, (uint8_t)x, (uint8_t)y, cz);
		if (b & (p[2] == 1 ? PC_WEST : PC_NORTH)) return 1;
	}
	return 0;
}

uint8_t pf_find(const pf_req_t *q, uint8_t *path, uint8_t maxlen) __banked
{
	if (q->page == PG_NONE || q->sx > PF_W || q->sy > PF_W) return 0;
	if (q->tx >= q->sx || q->ty >= q->sy) return 0;
	pf_cells = q->cells; pf_sx = q->sx; pf_sy = q->sy; pf_z = q->z;
	pf_step = q->step;
	uint8_t old = pg_map3(q->page);
	uint8_t *pf = (uint8_t *)0xC000;
	uint16_t *queue = (uint16_t *)(pf + PF_QUEUE);
	// Окно поиска: вокруг начала и цели с запасом. Не дошли — второй заход по всей карте.
	uint8_t bx0 = q->fx < q->tx ? q->fx : q->tx, bx1 = q->fx > q->tx ? q->fx : q->tx;
	uint8_t by0 = q->fy < q->ty ? q->fy : q->ty, by1 = q->fy > q->ty ? q->fy : q->ty;
	bx0 = bx0 > PF_MARGIN ? (uint8_t)(bx0 - PF_MARGIN) : 0;
	by0 = by0 > PF_MARGIN ? (uint8_t)(by0 - PF_MARGIN) : 0;
	bx1 = (uint8_t)(bx1 + PF_MARGIN);
	by1 = (uint8_t)(by1 + PF_MARGIN);
	if (bx1 >= q->sx) bx1 = (uint8_t)(q->sx - 1);
	if (by1 >= q->sy) by1 = (uint8_t)(q->sy - 1);
	for (uint8_t pass = 0; pass < 2; pass++) {
		if (pass) {                  // второй заход — вся карта
			bx0 = 0; by0 = 0;
			bx1 = (uint8_t)(q->sx - 1); by1 = (uint8_t)(q->sy - 1);
		}
		{                            // слепок клеток окна: карта читается рядами
			uint8_t rowbuf[PF_W * 4];
			uint16_t rb = (uint16_t)(bx1 - bx0 + 1) * 4;
			far_t ra = pf_cells + ((uint32_t)(((uint16_t)q->z * q->sy + by0) * q->sx + bx0) << 2);
			uint16_t step = (uint16_t)q->sx * 4;
			uint8_t *south = pf + PF_SOUTH;   // южные стены ряда выше — северные этого
			memset(south, 0, PF_W);
			for (uint8_t y = by0; y <= by1; y++, ra += step) {
				far_read(ra, rowbuf, rb);
				const uint8_t *c = rowbuf;
				uint8_t east = 0;             // восточная стена клетки левее — западная этой
				for (uint8_t x = bx0; x <= bx1; x++, c += 4) {
					uint8_t b = cell_pack(pf, c);
					if (east) b |= PC_WEST;
					if (south[x]) b |= PC_NORTH;
					uint8_t bw = c[3] ? pf[PF_BIGWALL + c[3]] : 0;
					east = bw == BW_EAST || bw == BW_ES;
					south[x] = bw == BW_SOUTH || bw == BW_ES;
					PF_CELL(x, y) = b;
				}
			}
		}
		memset(pf, 0xFF, 4096);
		uint16_t head = 0, tail = 0;
		PF_COST(q->fx, q->fy) = 0;
		PF_FROM(q->fx, q->fy) = (uint8_t)(q->z << 3);   // в старших битах — этаж клетки
		queue[tail++] = (uint16_t)q->fy * PF_W + q->fx;
		while (head != tail) {
			uint16_t cur = queue[head++];
			if (head >= PF_QMAX) head = 0;
			uint8_t cx = (uint8_t)(cur & (PF_W - 1)), cy = (uint8_t)(cur / PF_W);
			uint8_t cc = PF_COST(cx, cy);
			uint8_t cz = (uint8_t)(PF_FROM(cx, cy) >> 3);
			uint8_t stairs = cell_info(pf, cx, cy, cz) & PC_STAIRS;
			for (uint8_t d = 0; d < 8; d++) {
				int16_t nx = (int16_t)cx + pf_dx[d], ny = (int16_t)cy + pf_dy[d];
				if (nx < bx0 || ny < by0 || nx > bx1 || ny > by1) continue;
				// Этаж после шага (Pathfinding::getTUCost): вверх по ступеням,
				// вниз пока под ногами нет пола
				uint8_t nz = cz;
				uint8_t nb = cell_info(pf, (uint8_t)nx, (uint8_t)ny, nz);
				if (stairs && nz + 1 < q->sz) {
					uint8_t up = cell_info(pf, (uint8_t)nx, (uint8_t)ny, (uint8_t)(nz + 1));
					if (!(up & PC_NOFLOOR)) { nz++; nb = up; }
				}
				while (nz && (nb & PC_NOFLOOR))
					nb = cell_info(pf, (uint8_t)nx, (uint8_t)ny, --nz);
				uint8_t cost = (uint8_t)(nb >> 4);
				if (!cost) continue;
				if (d & 1) cost += cost >> 1;   // наискось дороже в полтора раза
				uint16_t nc = (uint16_t)cc + cost;
				if (nc > q->budget || nc >= PF_COST((uint8_t)nx, (uint8_t)ny)) continue;
				if (wall_blocked(pf, cx, cy, cz, d)) continue;
				PF_COST((uint8_t)nx, (uint8_t)ny) = (uint8_t)nc;
				PF_FROM((uint8_t)nx, (uint8_t)ny) = (uint8_t)(d | (nz << 3));
				queue[tail++] = (uint16_t)ny * PF_W + (uint16_t)nx;
				if (tail >= PF_QMAX) tail = 0;
				if (tail == head) { head = tail; break; }   // очередь кончилась
			}
		}
		if (PF_COST(q->tx, q->ty) != 0xFF) break;           // дошли
		if (!bx0 && !by0 && bx1 == q->sx - 1 && by1 == q->sy - 1) break;   // и так вся карта
	}
	// Путь пишется от цели назад. Длиннее maxlen — отдаём его первые maxlen шагов: боец
	// идёт, пока хватает времени и шагов, как в оригинале (Pathfinding::calculate ищет без
	// оглядки на время бойца, а UnitWalkBState останавливает его, когда время кончилось).
	// До 2026-11-13 длинный путь давал 0, и щелчок за пределами досягаемости не делал ничего.
	uint8_t n = 0;
	if (PF_COST(q->tx, q->ty) != 0xFF) {
		uint8_t x = q->tx, y = q->ty;
		uint16_t len = 0;
		while ((x != q->fx || y != q->fy) && len < PF_W * PF_W) {
			uint8_t d = PF_FROM(x, y) & 7;
			x = (uint8_t)((int16_t)x - pf_dx[d]);
			y = (uint8_t)((int16_t)y - pf_dy[d]);
			len++;
		}
		if (x == q->fx && y == q->fy) {
			n = len > maxlen ? maxlen : (uint8_t)len;
			uint16_t skip = len - n;   // хвост у цели, до которого не дойти
			uint8_t i = n;
			x = q->tx; y = q->ty;
			while (x != q->fx || y != q->fy) {
				uint8_t d = PF_FROM(x, y) & 7;
				if (skip) skip--;
				else path[--i] = d;
				x = (uint8_t)((int16_t)x - pf_dx[d]);
				y = (uint8_t)((int16_t)y - pf_dy[d]);
			}
		}
	}
	pg_map3(old);
	return n;
}
