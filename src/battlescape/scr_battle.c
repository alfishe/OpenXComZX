// Экран наземного боя: первая реализация отрисовки (16_battlescape_plan.md §8, этап Б1).
// Карта и её тайлсет — готовые ресурсы BATMAP0..2 / BATTILE0..2 из BATTLE.PAK (генератора
// карт ещё нет, поле замостил конвертер: tools/oxzconv/lib/battle.js). Рисуется всё подряд, без
// отсева по перекрытию: прототип показал, что отсев не окупается (§8.3a).
//
// Геометрия (Camera::convertMapToScreen): X = (x - y) * 16, Y = (x + y) * 8 - z * 24; спрайт
// клетки 32x40, вертикальное смещение части — MCD.P_Level. Порядок художника: уровни снизу
// вверх, внутри уровня — ряды Y, внутри ряда X (перекрывающие клетки идут позже), внутри
// клетки — пол, западная стена, северная стена, объект.
//
// Управление: левая кнопка — идти в клетку (по своему бойцу — выбрать его), правая —
// развернуться туда и открыть дверь (как поворот в оригинале: UnitTurnBState открывает
// дверь, к которой повернулся боец); N — следующий боец, Shift+N — предыдущий (в оригинале
// TAB и SHIFT); стрелки — камера, Q/A — этаж, G — пересобрать карту, ESC — выход.
#include <stdint.h>
#include <string.h>
#include "tsconf.h"
#include "memmap.h"
#include "res.h"
#include "res_ids.h"
#include "ui.h"
#include "gfx.h"
#include "input.h"
#include "far.h"
#include "pages.h"
#include "scrdef.h"
#include "dbg.h"
#include "mapgen.h"
#include "pathfind.h"
#include "globe.h"
#include "music.h"
#include "text.h"
#include "units.h"
#include "doors.h"
#include "loader.h"

#define VIEW_H     144               // окно карты; ниже — панель ICONS (56 строк)
#define TILE_W     32
#define TILE_H     40
#define MAP_MAXX   64                // предел ширины карты (буфер ряда)

static uint16_t gen_terrain;             // какой террейн пробует генератор (клавиша G)
// Параметры миссии, которые приносит геоскейп (bat_mission): развёртывание, карта НЛО,
// карта корабля отряда (всё — номера записей террейнов) и сам корабль в пуле кампании —
// от него берётся экипаж. #FFFF — «не задано»: бой отладочный, всё по умолчанию.
static uint16_t mis_deploy = 0xFFFF, mis_ufo = 0xFFFF, mis_craft = 0xFFFF, mis_crew = 0xFFFF;
static uint8_t m_sx, m_sy, m_sz, m_nt;
static uint8_t level;                // этаж камеры
// Показывать все этажи снизу до текущего или только текущий: кнопка «1/2» на панели,
// в оригинале Camera::toggleShowAllLayers. С одним этажом крыша корабля не мешает смотреть
// внутрь, но верхние этажи не видны — как в оригинале.
static uint8_t all_levels = 1;
static int16_t cam_x, cam_y;         // начало координат карты на экране
static int16_t yorg;                 // начало пространства строк кольца (см. «Сплит-экран» ниже)
static int16_t vx_lo, vx_hi;         // мировой диапазон X, который сейчас нарисован в кольце
static int16_t vy_lo, vy_hi;         // и строки R, которые в нём нарисованы
static uint8_t __at(0xBC00) tile_y[256];   // вертикальное смещение тайла (MCD.P_Level) — память банка
static far_t cells;                  // начало клеток карты
static far_t map_phys;               // где лежит ресурс карты (слот SD мог смениться)
static uint8_t loaded;
static uint8_t __at(0xBD00) row[MAP_MAXX * 4];   // ряд клеток карты (Win1 занято, стек в Win0 мал)
// Кадры тайлсета в готовом для блита виде (17_battle_render.md §2): при загрузке карты записи
// SPRSET (x, y, w, h, смещение/2) разворачиваются так, чтобы в кадре не осталось ни 32-битной
// арифметики far_t, ни делений — только сложения.
//   [0] страница источника, [1..2] смещение в ней, [3] DMALEN (w/2-1), [4] высота,
//   [5] dx, [6] dy (угол кадра в ячейке), [7] ширина
static uint8_t __at(0xB400) tile_tab[256 * TE_SIZE];

// Юниты на карте (отладка генератора, тумана войны пока нет). Спрайт собирается как в
// UnitSprite::drawRoutine0 — ноги, торс и руки по направлению; лист UNIT_* даёт 32 кадра
// в порядке: 0-7 левая рука, 8-15 правая, 16-23 ноги, 24-31 торс.
#define MAX_UNITS 12
#define UNIT_PARTS 4
typedef struct { uint8_t x, y, z, dir, alive, kneel; uint8_t tu, tu_max, hp, hp_max, en, mor; } unit_t;
static unit_t __at(0xBE00) units[MAX_UNITS];
static uint8_t nunits;
static uint8_t sel;                      // выбранный боец (панель показывает его состояние)
static uint8_t unit_page = PG_NONE, unit_np;
// Память банка (08 §4): units до #BE84, поэтому лист кадров начинается с #BF00 и занимает
// страницу до конца (#BFFF). Раньше он стоял с #BE40 и при семи и больше бойцах затирался
// ими — кадры блитились из случайной памяти, и отряд выглядел цветным мусором.
static uint8_t __at(0xBF00) unit_tab[32 * TE_SIZE];   // кадры листа в виде для блита
// Ноги на колене — восемь кадров листа (32..39), они идут после позы стоя
#define KNEEL_TU_DOWN  4                 // цена приседания и вставания (BattlescapeGame::kneel)
#define KNEEL_TU_UP    8
#define KNEEL_DY       4                 // всё, кроме ног, опускается на 4 точки (offYKneel)
static uint8_t __at(0xBEB0) kneel_tab[8 * TE_SIZE];
// Рабочая страница боя: массивы поиска пути, свойства частей и таблицы графики миссии
static uint8_t pf_page = PG_NONE;                // страница под рабочие массивы поиска пути

// Курсор клетки — как в оригинале (Map.cpp:679 и :968): рамка клетки в CURSOR.PCK разрезана
// на две части. Задняя (кадр 0) рисуется до содержимого клетки, передняя (кадр 3) — после
// бойца, поэтому рамка охватывает клетку объёмно: боец стоит внутри неё, а не поверх.
// Аппаратным спрайтом такого не сделать — спрайты TSU всегда поверх графики.
// Кадры: 0 — задняя половина красной рамки, 1 — жёлтой (на клетке боец), 3 и 4 — передние
#define CUR_FRAMES 4
static uint8_t __at(0xBE90) cur_tab[CUR_FRAMES * TE_SIZE];
static uint8_t cur_page = PG_NONE, cur_np;
static uint8_t cur_on, cur_cx, cur_cy;   // курсор на клетке (cur_cx, cur_cy) текущего этажа

// Дисплей-лист (17_battle_render.md §2): вид раскладывается в список готовых команд DMA —
// по 8 байт, ровно то, что выгружается в регистры. Строится при смене камеры, этажа или карты,
// а перерисовка становится циклом «прочитал 8 байт — записал 8 портов».
// Список живёт в двух страницах: карта миссии бывает 60x60 клеток в четыре этажа, и в одну
// страницу (2048 записей) вид перестал влезать — часть клеток просто не рисовалась.
#define DL_PAGE_N 2048                   // записей в странице (16 КБ / 8)
#define DL_MAX  (DL_PAGE_N * 2)
#define DL_SIZE 8
static uint8_t *const dl = (uint8_t *)0xC000;   // подключённая страница списка
static uint8_t dl_page = PG_NONE;        // первая из двух подряд
static uint16_t dl_n;                // записей в списке
static uint8_t dl_ok;                // список отвечает текущему виду

// Сплит-экран (17_battle_render.md §3): карта живёт в своём холсте и показывается
// смещением GYOffs, а панель ICONS остаётся на своём месте — на строке VIEW_H-1 строчное
// прерывание (crt0.s) переключает смещения на панельные. Так камеру можно двигать регистрами,
// не перерисовывая ни карту, ни панель.
// GYOffs — не постоянное смещение, а значение, которым перезагружается счётчик строки
// видеопамяти; дальше он растёт сам. Поэтому на разрезе ставится номер строки панели, а
// смещения карты возвращаются за SPLIT_LEAD строк до картинки (запас на длинный обработчик
// кадра со счётчиком и вводом) — с поправкой на эти строки.
#define SPLIT_TOP  73                // строк верхнего бордюра: VSInt считает их с картинкой
#define SPLIT_LEAD 0                 // за сколько строк до картинки вернуть смещения карты
// Карта живёт в своём холсте 512x512 (256c, 16 страниц листов TSU #20..#2F — в бою они свободны,
// лист курсора переезжает в строки экрана): до разреза прерывание ставит VPage карты, на разрезе —
// холст интерфейса с панелью (crt0.s, 02 §4: VPage действует со следующей строки). Холст —
// кольцо по обеим осям: GXOffs/GYOffs заворачиваются на 512 сами, поэтому камера в любую
// сторону — это запись смещений и дорисовка въехавшей полосы, без пересборки вида.
// Строки считаются в «пространстве кольца»: R = (x + y) * 8 - z * 24 + yorg, строка холста —
// R & 511. Полная перерисовка (смена этажа, центр на бойце) меняет yorg так, что новый вид
// собирается в половине холста, которой сейчас не видно, и показывается сразу, целиком.
#define MAP_PAGE TSU_PAGE            // холст карты (кратен 16, как требует VPage в 256c)
#define CUR_SHEET (SCREEN_PAGE + 8)  // лист курсора в бою: строки экрана 256..263 (кратна 8)
#define RING    512
#define BUF_W   RING
#define PAD_X   80                   // запас по X: 320 + 2*80 = 480 < 512, кольцо не перекрывается
#define PAD_Y   ((SCRATCH_H - VIEW_H) / 2)   // запас по Y при полной перерисовке: 52 строки
#define VY_MAX  (SCRATCH_H - 1)      // сколько строк держать готовыми: полоса по X — во всю их высоту
#define Y_AHEAD 24                   // строк за краем окна, которые должны быть готовы
#define Y_BAND  48                   // дорисовка по Y — полосами не тоньше этого (клетка 40 строк)
#define SCROLL_STEP 16               // точек за нажатие стрелки (и за повтор)
#define BIAS    1024                 // мировая X лежит в ±640; сдвиг делает её положительной
// Запасная полоса холста интерфейса: в ней собирается всякая дорисовка (17 §2). Карта из холста
// интерфейса ушла, и в бою его строки 200..511 ничьи (рабочая область ui.c 480..511 — только у
// воздушного боя, задний буфер глобуса 280..479 — только на геоскейпе); 256..263 — лист курсора.
#define SCRATCH_Y 264
#define SCRATCH_H (512 - SCRATCH_Y)  // 248
extern uint8_t split_gx, split_gy, split_on, split_phase, split_mark, map_vpage;
extern uint16_t map_gx, map_gy, split_line, vblank_line;

static void center_on_unit(void);       // определена ниже, вместе с юнитами
static void draw_strip(int16_t lo, int16_t hi);   // перерисовка полосы вида (ниже)
static void cell_repaint(uint8_t x, uint8_t y);   // перерисовка одной клетки (ниже)

// Включить сплит: до разреза — холст карты, после — панель со своей строки 144 холста интерфейса
static void split_start(void)
{
	split_on = 0;                        // на геоскейпе сплит включён (метка луча): пока меняем — выкл.
	map_gx = PAD_X;
	map_gy = 0;
	map_vpage = MAP_PAGE;
	split_gx = 0;
	split_gy = VIEW_H;                   // после разреза показываются строки панели (144..199)
	split_line = SPLIT_TOP + VIEW_H - 1;
	vblank_line = SPLIT_TOP - 1 - SPLIT_LEAD;
	split_phase = 0;
	split_mark = 0;                      // глобус включал метку луча без смещений (globe.s blit)
	split_on = 1;
	TS_VSINTL = (uint8_t)split_line;
	TS_VSINTH = (uint8_t)(split_line >> 8);
}

static void split_stop(void)
{
	split_on = 0;
	map_vpage = 0;
	TS_VPAGE = SCREEN_PAGE;
	TS_VSINTL = 0;                       // кадровое прерывание — снова в начале кадра
	TS_VSINTH = 0;
	TS_GXOFFSL = 0; TS_GXOFFSH = 0;
	TS_GYOFFSL = 0; TS_GYOFFSH = 0;
}

static void dma_wait(void)
{
	while (TS_DMASTATUS & DMASTATUS_ACT)
		;
}

// Прогон списка: на запись — ожидание DMA и восемь выгрузок регистров
static void dl_run(void)
{
	uint8_t old = pg_map3(dl_page);
	const uint8_t *p = dl;
	for (uint16_t i = dl_n, k = 0; i; i--, k++, p += DL_SIZE) {
		if (k == DL_PAGE_N) { pg_map3(dl_page + 1); p = dl; }
		dma_wait();
		TS_DMASAL = p[0]; TS_DMASAH = p[1]; TS_DMASAX = p[2];
		TS_DMADAL = p[3]; TS_DMADAH = p[4]; TS_DMADAX = p[5];
		TS_DMALEN = p[6];
		TS_DMANUM = p[7];
		TS_DMACTRL = DMA_BLT1 | DMA_D_ALGN | DMA_ASZ;
	}
	pg_map3(old);
}

// Вызывается, когда в Win3 уже подключена страница списка (build_range переключает по рядам)
static uint16_t dl_over;                 // сколько кадров не влезло в список (диагностика)

static uint8_t *dl_put(void)
{
	if (dl_n >= DL_MAX) { dl_over++; return 0; }
	if (dl_n == DL_PAGE_N) pg_map3(dl_page + 1);   // перевалили во вторую страницу
	return dl + (dl_n++ & (DL_PAGE_N - 1)) * DL_SIZE;
}

// Окно строк [win_y0, win_y1) (R), в которое пишут блиты, и куда они пишут: в кольцо карты
// или (to_scr) в запасную полосу холста интерфейса, где строка win_y0 — строка SCRATCH_Y.
static int16_t win_y0, win_y1;
static uint8_t to_scr;
static uint16_t r_ofs;
static uint8_t r_page;

static void row_at(int16_t by)
{
	uint16_t c;
	uint8_t pg;
	if (to_scr) { c = SCRATCH_Y + (uint16_t)(by - win_y0); pg = SCREEN_PAGE; }
	else { c = (uint16_t)by & (RING - 1); pg = MAP_PAGE; }
	r_ofs = (c & 31) << 9;
	r_page = pg + (uint8_t)(c >> 5);
}

// Кадр (запись вида tile_tab/unit_tab) -> команды дисплей-листа: источник лежит подряд
// (строка = w байт), приёмник
// шагает на 512 (BLT1 | D_ALGN | ASZ, 02 §6). Кадр — всегда одна команда; по краям окна он не
// обрезается (см. ниже), сверху и снизу обрезается строками окна.
static void dl_emit(uint16_t so, uint8_t sp, int16_t bx, int16_t by, int16_t h, uint8_t len, int16_t w);

static void dl_blit_c(const uint8_t *e, int16_t x, int16_t y)
{
	int16_t h = e[4];
	if (!e[7]) return;
	int16_t bx = (int16_t)((uint16_t)(x + e[5] + BIAS) & (BUF_W - 1)), by = y + e[6];
	uint8_t sp = e[0];
	uint16_t so = (uint16_t)e[1] | ((uint16_t)e[2] << 8);
	uint8_t len = e[3];
	int16_t w = e[7];
	if (bx & 1) return;                  // DMA адресует словами; cam_x и dx кадра всегда чётные
	if (by + h <= win_y0 || by >= win_y1) return;
	if (by < win_y0) {                   // верх кадра выше окна — пропустить строки
		so += (uint16_t)(win_y0 - by) * (uint16_t)w;
		h -= win_y0 - by;
		by = win_y0;
	}
	if (by + h > win_y1) h = win_y1 - by;
	// Кадр лёг на шов кольца по Y (строка 511 -> 0): две части, каждая — своей командой
	if (!to_scr) {
		int16_t c = by & (RING - 1);
		if (c + h > RING) {
			int16_t h1 = RING - c;
			dl_emit(so, sp, bx, by, h1, len, w);
			so += (uint16_t)h1 * (uint16_t)w;
			by += h1;
			h -= h1;
		}
	}
	dl_emit(so, sp, bx, by, h, len, w);
}

// Быстрый путь того же на ассемблере: кадр не на шве кольца по X (почти все). Сборка списка —
// это блиты, и в коде SDCC (локальные в кадре IX) кадр стоил ~4400 тактов, а с dl_emit, row_at
// и dl_put — 95% времени сборки: полоса по Y в 48 строк собиралась 5-7 кадров. Кадр на шве по X
// уходит в dl_blit_c. Поля кадра: e[0] страница, e[1..2] смещение, e[3] длина строки в словах - 1,
// e[4] высота, e[5] dx, e[6] dy, e[7] ширина в байтах.
_Static_assert(BIAS == 1024 && RING == 512 && DL_PAGE_N == 2048 && DL_MAX == 4096,
	       "dl_blit: константы зашиты в ассемблер");
static uint16_t bl_so, bl_bx;
static int16_t bl_by;
static uint8_t bl_sp, bl_len, bl_w, bl_h;

static void dl_blit(const uint8_t *e, int16_t x, int16_t y) __naked
{
	(void)e; (void)x; (void)y;
	__asm
	; HL = e, DE = x, в стеке: возврат, y (снимает вызываемый)
	push	hl
	push	de
	push	hl
	pop	iy
	ld	a, 7 (iy)		; ширина 0 - пустой кадр
	or	a, a
	jp	Z, 90$
	ld	(_bl_w), a
	ld	c, 5 (iy)
	ld	b, #0
	ex	de, hl
	add	hl, bc			; x + dx
	ld	a, h
	add	a, #4			; + BIAS
	and	a, #1
	ld	h, a			; bx = (x + dx + BIAS) & 511
	bit	0, l
	jp	NZ, 90$			; DMA адресует словами
	ld	(_bl_bx), hl
	ld	c, 7 (iy)
	add	hl, bc
	ld	bc, #-513
	add	hl, bc
	jp	C, 80$			; bx + w > 512 - шов кольца по X
	ld	a, 0 (iy)
	ld	(_bl_sp), a
	ld	l, 1 (iy)
	ld	h, 2 (iy)
	ld	(_bl_so), hl
	ld	a, 3 (iy)
	ld	(_bl_len), a
	ld	hl, #6			; стек: x, e, возврат, y
	add	hl, sp
	ld	a, (hl)
	inc	hl
	ld	h, (hl)
	ld	l, a
	ld	c, 6 (iy)
	ld	b, #0
	add	hl, bc			; y + dy
	ex	de, hl			; DE = by
	ld	a, 4 (iy)
	ld	(_bl_h), a
	ld	l, a
	ld	h, b
	add	hl, de
	ld	bc, (_win_y0)
	or	a, a
	sbc	hl, bc			; by + h - win_y0
	jp	Z, 90$
	jp	M, 90$			; целиком выше окна
	ld	h, d
	ld	l, e
	ld	bc, (_win_y1)
	or	a, a
	sbc	hl, bc
	jp	P, 90$			; целиком ниже окна
	ld	hl, (_win_y0)
	or	a, a
	sbc	hl, de			; win_y0 - by
	jr	Z, 10$
	jp	M, 10$
	ld	a, (_bl_h)		; верх выше окна: пропустить L строк (L < h)
	sub	a, l
	ld	(_bl_h), a
	ld	a, (_bl_w)
	ld	e, a
	ld	h, l
	ld	l, #0
	ld	d, l
	ld	b, #8
11$:
	add	hl, hl
	jr	NC, 12$
	add	hl, de
12$:
	djnz	11$			; HL = пропуск * w
	ld	bc, (_bl_so)
	add	hl, bc
	ld	(_bl_so), hl
	ld	de, (_win_y0)
10$:
	ld	hl, (_win_y1)
	or	a, a
	sbc	hl, de			; win_y1 - by > 0
	ld	a, h
	or	a, a
	jr	NZ, 20$
	ld	a, (_bl_h)
	cp	a, l
	jr	C, 20$
	jr	Z, 20$
	ld	a, l
	ld	(_bl_h), a		; низ ниже окна - обрезать
20$:
	ld	(_bl_by), de
	ld	a, (_to_scr)
	or	a, a
	jr	NZ, 40$
	ld	a, d			; шов кольца по Y: (by & 511) + h > 512
	and	a, #1
	ld	h, a
	ld	l, e
	ld	a, (_bl_h)
	ld	c, a
	ld	b, #0
	add	hl, bc
	ld	bc, #-513
	add	hl, bc
	jr	NC, 40$
	ld	a, e
	neg
	ld	b, a			; h1 = 512 - (by & 511), меньше h
	ld	a, (_bl_h)
	sub	a, b
	ld	c, a			; остаток
	push	bc
	ld	a, b
	ld	(_bl_h), a
	call	50$
	pop	bc
	ld	a, c
	ld	(_bl_h), a
	ld	a, (_bl_w)
	ld	e, a
	ld	h, b
	ld	l, #0
	ld	d, l
	ld	b, #8
41$:
	add	hl, hl
	jr	NC, 42$
	add	hl, de
42$:
	djnz	41$			; HL = h1 * w
	ld	bc, (_bl_so)
	add	hl, bc
	ld	(_bl_so), hl
	ld	hl, (_bl_by)		; вторая часть - с начала следующего круга кольца
	ld	a, h
	or	a, #1
	ld	h, a
	ld	l, #0xFF
	inc	hl
	ld	(_bl_by), hl
40$:
	call	50$
90$:
	pop	de
	pop	de
	pop	hl
	pop	af
	jp	(hl)
80$:
	pop	de			; редкий случай - на C, с теми же аргументами
	pop	hl
	jp	_dl_blit_c

	; Команда в список: bl_so/bl_sp, столбец bl_bx, строка bl_by, высота bl_h
50$:
	ld	hl, (_dl_n)
	ld	a, h
	cp	a, #0x10		; DL_MAX
	jr	C, 51$
	ld	hl, (_dl_over)
	inc	hl
	ld	(_dl_over), hl
	ret
51$:
	cp	a, #0x08		; A = старший байт; ровно DL_PAGE_N - во вторую страницу списка
	jr	NZ, 52$
	ld	a, l
	or	a, a
	jr	NZ, 52$
	ld	a, (_dl_page)
	inc	a
	call	_pg_map3
	ld	hl, (_dl_n)
52$:
	ld	b, h
	ld	c, l
	inc	bc
	ld	(_dl_n), bc
	ld	a, h
	and	a, #0x07
	ld	h, a
	add	hl, hl
	add	hl, hl
	add	hl, hl
	ld	a, h
	or	a, #0xC0
	ld	h, a			; HL = #C000 + (dl_n & 2047) * 8
	ld	de, (_bl_so)
	ld	a, d
	rlca
	rlca
	and	a, #3
	ld	c, a
	ld	a, (_bl_sp)
	add	a, c
	ld	c, a			; страница + so >> 14
	ld	a, d
	and	a, #0x3F
	ld	(hl), e
	inc	hl
	ld	(hl), a
	inc	hl
	ld	(hl), c
	inc	hl
	ld	de, (_bl_by)
	ld	b, #MAP_PAGE
	ld	a, (_to_scr)
	or	a, a
	jr	Z, 53$
	push	hl			; запасная полоса: строка SCRATCH_Y + (by - win_y0)
	ex	de, hl
	ld	de, (_win_y0)
	or	a, a
	sbc	hl, de
	ld	de, #SCRATCH_Y
	add	hl, de
	ex	de, hl
	pop	hl
	ld	b, #SCREEN_PAGE
53$:
	ld	a, (_bl_bx)
	ld	(hl), a
	inc	hl
	ld	a, e
	and	a, #31
	add	a, a
	ld	c, a
	ld	a, (_bl_bx+1)
	add	a, c
	ld	(hl), a			; (строка & 31) * 512 + bx
	inc	hl
	ld	a, e
	rlca
	rlca
	rlca
	and	a, #7
	ld	c, a
	ld	a, d
	and	a, #1
	add	a, a
	add	a, a
	add	a, a
	or	a, c
	add	a, b
	ld	(hl), a			; страница строки
	inc	hl
	ld	a, (_bl_len)
	ld	(hl), a
	inc	hl
	ld	a, (_bl_h)
	dec	a
	ld	(hl), a
	ret
	__endasm;
}

// Команды для куска кадра высотой h со строки by (R) и столбца bx кольца
static void dl_emit(uint16_t so, uint8_t sp, int16_t bx, int16_t by, int16_t h, uint8_t len, int16_t w)
{
	while (so >= 0x4000) { so -= 0x4000; sp++; }
	// Кадр не на стыке кольца — одна команда на кадр, обрезан он по строкам или нет.
	// (До 2026-11-13 обрезанный по строкам кадр шёл веткой стыка ниже, и та считала его
	// строку длиной до конца строки буфера: мазня на всю ширину. На краях буфера её не было
	// видно, в окне перерисовки клетки — стало.)
	if (bx + w <= BUF_W) {
		uint8_t *q = dl_put();
		if (!q) return;
		row_at(by);
		uint16_t o = r_ofs + (uint16_t)bx;
		q[0] = (uint8_t)so; q[1] = (uint8_t)(so >> 8); q[2] = sp;
		q[3] = (uint8_t)o; q[4] = (uint8_t)(o >> 8); q[5] = r_page;
		q[6] = len;
		q[7] = (uint8_t)(h - 1);
		return;
	}
	// Кадр лёг на стык кольца: левая часть идёт в конец строки буфера, правая — в начало.
	// Строки при этом короче шага источника, поэтому команда на строку (таких кадров мало —
	// только те, что попали на стык).
	uint16_t step = (uint16_t)w;
	uint16_t w1 = (uint16_t)(BUF_W - bx) & ~1;       // сколько влезает до конца строки
	uint16_t w2 = ((uint16_t)w - w1) & ~1;           // остаток — в начало строки
	while (h > 0) {
		uint8_t *d;
		row_at(by);
		if (w1) {
			d = dl_put();
			if (!d) return;
			uint16_t offs = r_ofs + (uint16_t)bx;
			d[0] = (uint8_t)so; d[1] = (uint8_t)(so >> 8); d[2] = sp;
			d[3] = (uint8_t)offs; d[4] = (uint8_t)(offs >> 8); d[5] = r_page;
			d[6] = (uint8_t)(w1 / 2 - 1);
			d[7] = 0;
		}
		if (w2) {
			uint16_t so2 = so + w1;
			uint8_t sp2 = sp;
			if (so2 >= 0x4000) { so2 -= 0x4000; sp2++; }
			d = dl_put();
			if (!d) return;
			uint16_t offs = r_ofs;
			d[0] = (uint8_t)so2; d[1] = (uint8_t)(so2 >> 8); d[2] = sp2;
			d[3] = (uint8_t)offs; d[4] = (uint8_t)(offs >> 8); d[5] = r_page;
			d[6] = (uint8_t)(w2 / 2 - 1);
			d[7] = 0;
		}
		so += step;
		if (so >= 0x4000) { so -= 0x4000; sp++; }
		by++;
		h--;
	}
}

// Кадр карты по номеру части: вертикальное смещение части (MCD.P_Level) учтено вызывающим
static void dl_tile(uint8_t t, int16_t x, int16_t y)
{
	dl_blit(tile_tab + (uint16_t)t * TE_SIZE, x, y);
}

static const wdef_t w_battle[] = {
	// Виджет карты: рисует экран (EVT_DRAW) и отдаёт клики экрану (EVT_BUTTON, arg 0) —
	// по ним боец идёт в клетку. Панель ниже перекрыта своими кнопками.
	CUSR(0, 0, 320, VIEW_H, DYN(0), A_CUSTOM, 0),
	// Панель ICONS: кнопки на тех же местах, что в оригинале (BattlescapeState.cpp:100-115).
	HOT(48, 144, 32, 16, A_CUSTOM, 1, 0),            // боец выше по списку
	HOT(48, 160, 32, 16, A_CUSTOM, 2, 0),            // боец ниже
	HOT(80, 144, 32, 16, A_CUSTOM, 3, 0),            // этаж вверх
	HOT(80, 160, 32, 16, A_CUSTOM, 4, 0),            // этаж вниз
	HOT(112, 160, 32, 16, A_CUSTOM, 10, 'k'),        // присесть и встать
	HOT(144, 144, 32, 16, A_CUSTOM, 5, 'i'),         // инвентарь
	HOT(144, 160, 32, 16, A_CUSTOM, 6, 'c'),         // центрировать на бойце
	HOT(176, 144, 32, 16, A_CUSTOM, 7, 0),           // следующий боец
	HOT(208, 144, 32, 16, A_CUSTOM, 9, 0),           // показывать все этажи или только текущий
	HOT(240, 144, 32, 16, A_CUSTOM, 8, 0),           // конец хода
	HOT(240, 160, 32, 16, A_POP, 0, ESC),          // выйти из боя
};

static const scr_t tab[] = {
	SCR(SCR_BATTLE, UI_SCR_SAVEMENUS, RES_PAL_BATTLESCAPE, 0, SF_RAWPAL, w_battle),
};

// Камера не должна уводить карту из окна (иначе вид пустой, а перерисовка всё равно идёт):
// крайние клетки дают X от -(sy-1)*16 до (sx-1)*16 и Y от -level*24 до (sx+sy-2)*8.
static void clamp_cam(void)
{
	int16_t lo = TILE_W - (int16_t)(m_sx - 1) * 16, hi = SCREEN_W - TILE_W + (int16_t)(m_sy - 1) * 16;
	if (cam_x < lo) cam_x = lo;
	if (cam_x > hi) cam_x = hi;
	lo = TILE_H - (int16_t)(m_sx + m_sy - 2) * 8;
	hi = VIEW_H - TILE_H + (int16_t)level * 24;
	if (cam_y < lo) cam_y = lo;
	if (cam_y > hi) cam_y = hi;
	cam_x &= ~1;                         // блит DMA адресует словами
	// Холст карты — кольцо по обеим осям: въехавшие полосы дорисовывает draw_map,
	// пересборка вида тут не нужна (до 2026-11-13 уход по Y за запас 56 строк пересобирал весь вид)
}

// Камера в центр карты: середина поля попадает в середину окна
static void center(void)
{
	int16_t cx = m_sx / 2, cy = m_sy / 2;
	cam_x = 160 - (cx - cy) * 16;
	cam_y = VIEW_H / 2 - ((cx + cy) * 8 - (int16_t)level * 24);
	dl_ok = 0;
	clamp_cam();
}

// Разложить вид в дисплей-лист: уровни снизу вверх, ряды Y, внутри ряда X, внутри клетки —
// пол, западная стена, северная стена, объект (порядок художника, Map.cpp:626-966)
// Разложить в список клетки, чья мировая экранная координата X попадает в [lo, hi]. Мировая X
// клетки — (x - y) * 16, от камеры не зависит; в буфере ей отвечает колонка (X + BIAS) & 511,
// то есть буфер по горизонтали кольцевой и при движении камеры ничего не переезжает — надо лишь
// дорисовать въехавшую полосу. Полоса берётся с запасом в ширину спрайта: клетка рисуется
// целиком, поэтому в неё должны попасть и соседи, чьи спрайты в неё заезжают.
// Кадр юнита в дисплей-лист (как dl_tile, но кадры берутся из своего листа)
static void dl_unit_frame(uint8_t fr, int16_t x, int16_t y)
{
	const uint8_t *e = unit_tab + (uint16_t)fr * TE_SIZE;
	if (!e[7]) return;
	dl_blit(e, x, y);
}

// Стоит ли в клетке живой боец (цвет рамки курсора)
// Номер бойца в клетке + 1 (0 — никого): по нему и рисуют, и выбирают щелчком
static uint8_t unit_no(uint8_t z, uint8_t y, uint8_t x)
{
	for (uint8_t i = 0; i < nunits; i++) {
		const unit_t *u = &units[i];
		uint8_t uz = u->z, uy = u->y, ux = u->x;
		if (u->alive && uz == z && uy == y && ux == x) return (uint8_t)(i + 1);
	}
	return 0;
}

static uint8_t unit_at(uint8_t z, uint8_t y, uint8_t x)
{
	return unit_no(z, y, x) != 0;
}

// Боец в этой клетке (если он тут есть): ноги, торс, руки по направлению
static void draw_unit_at(uint8_t z, uint8_t y, uint8_t x, int16_t px, int16_t py)
{
	if (!nunits || unit_page == PG_NONE) return;
	for (uint8_t i = 0; i < nunits; i++) {
		const unit_t *u = &units[i];
		if (!u->alive || u->z != z || u->y != y || u->x != x) continue;
		uint8_t d = u->dir & 7;
		int16_t dy = 0;
		if (u->kneel) {                      // на колене: свои ноги, остальное ниже
			const uint8_t *e = kneel_tab + (uint16_t)d * TE_SIZE;
			if (e[7]) dl_blit(e, px, py);
			dy = KNEEL_DY;
		} else
			dl_unit_frame(16 + d, px, py);   // ноги
		dl_unit_frame(24 + d, px, py + dy);  // торс
		dl_unit_frame(0 + d, px, py + dy);   // левая рука
		dl_unit_frame(8 + d, px, py + dy);   // правая рука
		return;
	}
}

// Окно буфера по Y для сборки списка: перерисовка клетки (курсор, шаг бойца) трогает
// полосу не на всю высоту, а только вокруг себя — иначе на каждое движение мыши
// пересобирался бы весь столбец карты.
static int16_t clip_y0, clip_y1;

static void build_range(int16_t lo, int16_t hi)
{
	dl_n = 0;
	int16_t dlo = (lo - TILE_W + 1 + 15) >> 4, dhi = hi >> 4;   // x - y для краёв полосы
	for (uint8_t z = all_levels ? 0 : level; z <= level; z++) {
		// Какие ряды вообще могут попасть в буфер: по X полоса задаёт x - y = d из [dlo, dhi],
		// значит by = (2y + d) * 8 - z * 24 + B, и из clip_y0 - 40 < by <= clip_y1 — границы y.
		int16_t b = yorg - (int16_t)z * 24;
		int16_t ylo = (clip_y0 - TILE_H + 1 - 8 * dhi - b + 15) >> 4;
		int16_t yhi = (clip_y1 - 8 * dlo - b) >> 4;
		if (ylo < 0) ylo = 0;
		if (yhi >= m_sy) yhi = m_sy - 1;
		// Адрес ряда ведётся сложением: 32-битное умножение на каждый ряд стоило дороже,
		// чем всё остальное в этом цикле вместе взятое.
		uint16_t row_bytes = (uint16_t)m_sx * 4;
		far_t rbase = cells + (uint32_t)(((uint32_t)z * m_sy + ylo) * m_sx) * 4;
		for (int16_t y = ylo; y <= yhi; y++, rbase += row_bytes) {
			int16_t ry = (int16_t)y * 8 - (int16_t)z * 24 + yorg;
			int16_t rx = -(int16_t)y * 16;   // мировая X клетки x этого ряда: rx + x*16
			// Отрезок ряда: из lo-32 < wx <= hi и clip_y0-40 < py <= clip_y1 получаем границы x
			int16_t x0 = (lo - TILE_W + 1 - rx + 15) >> 4, x1 = (hi - rx) >> 4;
			int16_t t0 = (clip_y0 - TILE_H + 1 - ry + 7) >> 3, t1 = (clip_y1 - ry) >> 3;
			if (t0 > x0) x0 = t0;
			if (t1 < x1) x1 = t1;
			if (x0 < 0) x0 = 0;
			if (x1 >= m_sx) x1 = m_sx - 1;
			if (x0 > x1) continue;
			far_read(rbase + (uint16_t)x0 * 4, row, (uint16_t)(x1 - x0 + 1) * 4);
			// Есть ли в ряду бойцы: перебор отряда на каждую клетку стоил больше самих блитов
			uint8_t urow = 0;
			for (uint8_t i = 0; i < nunits; i++) {
				const unit_t *u = &units[i];
				uint8_t uz = u->z, uy = u->y;    // сравнения байтов — с копиями (SDCC 4.5)
				if (u->alive && uz == z && uy == (uint8_t)y) { urow = 1; break; }
			}
			// дальше пишем команды в страницу списка — ту, в которой сейчас его конец
			uint8_t old = pg_map3(dl_n >= DL_PAGE_N ? dl_page + 1 : dl_page);
			const uint8_t *p = row;
			int16_t px = rx + x0 * 16, py = ry + x0 * 8;
			for (int16_t x = x0; x <= x1; x++, p += 4, px += 16, py += 8) {
				uint8_t cx = cur_cx, cy = cur_cy;   // сравнения байтов — с копиями (SDCC 4.5)
				uint8_t here = cur_on && z == level && (uint8_t)x == cx && (uint8_t)y == cy;
				// на клетке боец — рамка жёлтая, пустая клетка — красная (как в оригинале)
				uint8_t cf = here && unit_at(z, (uint8_t)y, (uint8_t)x) ? 1 : 0;
				if (here) dl_blit(cur_tab + cf * TE_SIZE, px, py);          // задняя половина
				for (uint8_t k = 0; k < 4; k++) {
					uint8_t t = p[k];
					if (!t) continue;
					dl_tile((uint8_t)(t - 1), px, py - (int16_t)tile_y[t - 1]);   // px — мировая X
				}
				// Боец идёт сразу за своей клеткой: клетки правее и ниже рисуются позже и
				// закрывают его — иначе он виден сквозь стены и закрытые двери.
				if (urow) draw_unit_at(z, (uint8_t)y, (uint8_t)x, px, py);
				if (here) dl_blit(cur_tab + (2 + cf) * TE_SIZE, px, py);    // передняя половина
			}
			pg_map3(old);
		}
	}
}

// Камера внутри кольца: показать нужное место одной парой регистров. Строка R видна на строке
// окна R - (yorg - cam_y). Прерывание читает пару на кадровой строке — меняем её целиком.
static void show_cam(void)
{
	uint16_t gx = (uint16_t)(BIAS - cam_x) & (BUF_W - 1);
	uint16_t gy = (uint16_t)(yorg - cam_y - SPLIT_LEAD) & (RING - 1);
	__critical { map_gx = gx; map_gy = gy; }
}

// DMA по столбцам кольца — мировой диапазон [lo, hi] по X, rows строк: src и dst — адреса
// столбца 0 первой строки (шаг строки 512). FILL повторяет слово по адресу src. На завороте
// кольца получается два куска.
static void dma_cols(uint8_t ctrl, int16_t lo, int16_t hi, far_t src, far_t dst, uint16_t rows)
{
	uint16_t c0 = (uint16_t)(lo + BIAS) & (BUF_W - 1);
	uint16_t n = (uint16_t)(hi - lo + 1);
	if (n > BUF_W) n = BUF_W;
	while (n) {
		uint16_t part = BUF_W - c0;      // до конца строки буфера
		if (part > n) part = n;
		uint16_t w = (part + 1) & ~1;
		far_t s = src + c0, d = dst + c0;
		if (ctrl & DMA_FILL) {
			uint16_t zero = 0;
			far_write(s, &zero, 2);
		}
		dma_wait();
		TS_DMASAL = (uint8_t)FAR_OFFS(s); TS_DMASAH = (uint8_t)(FAR_OFFS(s) >> 8);
		TS_DMASAX = FAR_PAGE(s);
		TS_DMADAL = (uint8_t)FAR_OFFS(d); TS_DMADAH = (uint8_t)(FAR_OFFS(d) >> 8);
		TS_DMADAX = FAR_PAGE(d);
		TS_DMALEN = (uint8_t)(w / 2 - 1);
		TS_DMANUM = (uint8_t)(rows - 1);
		TS_DMACTRL = ctrl;
		dma_wait();
		n -= part;
		c0 = 0;
	}
}

// То же для строк кольца: rows строк со строки r0 (R). Шов кольца (511 -> 0) и предел DMA
// (256 пачек) режут работу на куски. src — источник первой строки (шаг 512), 0 — FILL на месте.
static void ring_cols(uint8_t ctrl, int16_t lo, int16_t hi, int16_t r0, uint16_t rows, far_t src)
{
	uint16_t c = (uint16_t)r0 & (RING - 1);
	while (rows) {
		uint16_t n = RING - c;
		if (n > rows) n = rows;
		if (n > 256) n = 256;
		far_t d = FAR(MAP_PAGE + (uint8_t)(c >> 5), (c & 31) << 9);
		dma_cols(ctrl, lo, hi, src ? src : d, d, n);
		if (src) src += (far_t)n << 9;
		rows -= n;
		c = (c + n) & (RING - 1);
	}
}


// Лист юнита в память и в готовые для блита записи (как тайлсет карты)
// Лист спрайтов грузит банк 30 (loader.c): страницу берёт он, таблицу кадров кладёт
// в дальнюю память, а сюда, в память банка, она переносится одним чтением.
// n — сколько кадров разобрать, ncopy — сколько записей перенести в tab. Разделены не зря:
// у листа брони кадров 40, а в unit_tab влезает 32 (хвост #BF00..#BFFF), и копия «на всё»
// уезжала за #C000 — прямо в окно Win3, где в этот миг лежат таблицы частей миссии.
static uint8_t load_sheet(uint16_t res, uint8_t *pg, uint8_t *np, uint8_t n,
			  const uint8_t *want, uint8_t *tab, uint8_t ncopy)
{
	if (pf_page == PG_NONE) return 0;
	// Переменные банка (кроме __at-массивов) лежат в Win1, а он подключён всегда — значит
	// указатели на них можно отдавать и в другой банк.
	if (!sheet_load(res, pg, np, n, want, FAR(pf_page + 1, TL_SHEET))) return 0;
	far_read(FAR(pf_page + 1, TL_SHEET), tab, (uint16_t)ncopy * TE_SIZE);
	return 1;
}

static uint8_t load_unit_sheet(uint16_t id)
{
	if (unit_page != PG_NONE) { pg_free(unit_page, unit_np); unit_page = PG_NONE; }
	if (!load_sheet(id, &unit_page, &unit_np, 40, 0, unit_tab, 32)) return 0;
	far_read(FAR(pf_page + 1, TL_SHEET) + 32 * TE_SIZE, kneel_tab, sizeof kneel_tab);
	return 1;
}

// Лист курсора клетки: из CURSOR.PCK берутся четыре кадра — задние и передние половины рамки
static uint8_t load_cursor(void)
{
	uint8_t want[CUR_FRAMES] = { 0, 1, 3, 4 };   // в стеке: банк вызывающего при вызове отключён
	return load_sheet(RES_CURSOR_PCK, &cur_page, &cur_np, CUR_FRAMES, want, cur_tab, CUR_FRAMES);
}

// Навести камеру на выбранного бойца (кнопка «центрировать», как в оригинале)
static void center_on_unit(void)
{
	if (!nunits) return;
	const unit_t *u = &units[sel < nunits ? sel : 0];
	cam_x = 160 - ((int16_t)u->x - (int16_t)u->y) * 16;
	cam_y = VIEW_H / 2 - (((int16_t)u->x + (int16_t)u->y) * 8 - (int16_t)level * 24);
	dl_ok = 0;
	clamp_cam();
}

// Высадка отряда: экипаж корабля миссии и его места на карте считает units.c (банк 30) —
// в банке боя для этого уже нет места. Здесь только перенос в таблицу бойцов вида.
static void place_squad(uint8_t debug_n)
{
	crew_req_t q;
	cunit_t cu[MAX_UNITS];
	nunits = 0;
	mapgen_craft(&q.cx, &q.cy, &q.cw, &q.cl, &q.part_min);
	q.cells = cells; q.sx = m_sx; q.sy = m_sy;
	q.craft = mis_crew; q.debug_n = debug_n;
	uint8_t n = crew_deploy(&q, cu, MAX_UNITS);
	for (uint8_t i = 0; i < n; i++) {
		units[i].x = cu[i].x; units[i].y = cu[i].y; units[i].z = cu[i].z;
		units[i].dir = 0; units[i].alive = 1; units[i].kneel = 0;
		units[i].tu = units[i].tu_max = cu[i].tu;
		units[i].hp = units[i].hp_max = cu[i].hp;
		units[i].en = cu[i].en; units[i].mor = cu[i].mor;
	}
	nunits = n;
}


// ---------------------------------------------------------------- ход бойца
// Поиск пути — волна по клеткам текущего этажа (Pathfinding оригинала считает ещё и
// подъёмы, стоимость частей и приседание; здесь пока ровная цена шага). Рабочие массивы
// лежат в своей странице пула и видны через Win3: стоимость и откуда пришли, по байту
// на клетку карты (до 64x64).
#define STEP_TU        4                 // единиц времени за шаг (в оригинале зависит от пола)
#define PATH_MAX       24

static uint8_t path[PATH_MAX], path_n, path_i;   // направления шагов
static uint8_t move_wait;                        // кадров до следующего шага
static uint8_t turn_dir = 0xFF;                  // куда разворачивается боец (правая кнопка)
static uint8_t ndoors;                           // дверей среди частей карты (отладка)

#define MC_SIZE 12                       // байт на часть в таблице набора (MCDSET, 16 §2.3)

// Свойства частей лежат в странице поиска пути (pathfind.h): её читает и поиск, и бой
static void pf_put(uint16_t off, uint8_t v)
{
	if (pf_page != PG_NONE) far_write(FAR(pf_page, off), &v, 1);
}

static uint8_t pf_get(uint16_t off)
{
	return pf_page == PG_NONE ? 0 : far_byte(FAR(pf_page, off));
}

// Смещения восьми направлений (0 — север, дальше по часовой, как в оригинале)
// Своя копия: таблицы из банка поиска пути видны только при подключённом том банке
static const int8_t dir_dx[8] = { 0, 1, 1, 1, 0, -1, -1, -1 };
static const int8_t dir_dy[8] = { -1, -1, 0, 1, 1, 1, 0, -1 };

// Экранная точка -> клетка карты (Camera::convertScreenToMap оригинала: к точке добавляется
// -32/2 и 24 на каждый этаж, дальше косой пересчёт). Клетке принадлежат нижние 16 строк её
// тайла 32x40 — там же рисуется ромб курсора: клетка ровно та же, что в оригинале.
static uint8_t screen_to_cell(int16_t mx, int16_t my, uint8_t *ox, uint8_t *oy)
{
	int16_t a = mx - cam_x;                              // (x - y) * 16
	int16_t b = my - cam_y + (int16_t)level * 24 - TILE_W / 2;   // (x + y) * 8
	int16_t x = (a + 2 * b - 32) / 32, y = (2 * b - a) / 32;
	if (x < 0 || y < 0 || x >= m_sx || y >= m_sy) return 0;
	*ox = (uint8_t)x; *oy = (uint8_t)y;
	return 1;
}

// Следующий и предыдущий боец отряда: выбор, камера на него и отмена начатого пути
// (BattlescapeState::btnNextSoldierClick — в оригинале камера тоже переезжает)
static void sel_next(void)
{
	if (!nunits) return;
	sel = (uint8_t)((sel + 1) % nunits);
	path_n = 0;
	center_on_unit();
	ui_dirty(0);
}

static void sel_prev(void)
{
	if (!nunits) return;
	sel = (uint8_t)((sel + nunits - 1) % nunits);
	path_n = 0;
	center_on_unit();
	ui_dirty(0);
}

// Карта для банка клеток (doors.c): двери и цена прохода считаются там
static dmap_t bmap;

// Открыть дверь в направлении dir и перерисовать изменившиеся клетки.
// 0 — открыли, 1 — не хватило времени, 2 — двери нет.
static uint8_t door_try(unit_t *u, uint8_t dir, uint8_t rclick)
{
	uint8_t list[8], spent = 0;
	memset(list, 0xFF, sizeof list);     // #FF — конец списка: координаты меньше 64
	uint8_t r = door_open(&bmap, u->x, u->y, u->z, dir, rclick, u->tu, &spent, list, 4);
	if (r) return r;
	u->tu -= spent;
	for (uint8_t i = 0; i < 4 && list[i * 2] != 0xFF; i++)
		cell_repaint(list[i * 2], list[i * 2 + 1]);
	return 0;
}

// Присесть или встать (BattlescapeGame::kneel): 4 единицы времени вниз, 8 вверх.
// Сидящего бойца хуже видно и точнее стреляет — это появится вместе с видимостью и стрельбой.
static void do_kneel(void)
{
	if (!nunits) return;
	unit_t *u = &units[sel < nunits ? sel : 0];
	uint8_t cost = u->kneel ? KNEEL_TU_UP : KNEEL_TU_DOWN;
	if (u->tu < cost) return;
	u->tu -= cost;
	u->kneel = !u->kneel;
	path_n = 0;
	cell_repaint(u->x, u->y);
	ui_dirty(0);
}

// Повернуться на одну восьмую в сторону d (в оригинале поворот при ходьбе бесплатен и
// идёт по одному шагу за такт — отсюда и разворот на месте перед шагом)
static void turn_to(unit_t *u, uint8_t d)
{
	uint8_t diff = (uint8_t)((d - u->dir) & 7);
	u->dir = (uint8_t)((u->dir + (diff && diff <= 4 ? 1 : 7)) & 7);
	cell_repaint(u->x, u->y);
}

// Один шаг по пути: поворот, открывание двери, перенос в клетку и расход времени
static void step_unit(void)
{
	if (!nunits || path_i >= path_n) { path_n = 0; return; }
	unit_t *u = &units[sel < nunits ? sel : 0];
	uint8_t d = path[path_i];
	if (u->kneel) {                                  // идти на коленях нельзя — сперва встать
		if (u->tu < KNEEL_TU_UP) { path_n = 0; return; }
		u->tu -= KNEEL_TU_UP;
		u->kneel = 0;
		cell_repaint(u->x, u->y);
		return;
	}
	if (u->dir != d) { turn_to(u, d); return; }      // сперва развернуться лицом к шагу
	if (door_try(u, d, 0) != 2) return;              // дверь открывается вместо шага
	int16_t nx = (int16_t)u->x + dir_dx[d], ny = (int16_t)u->y + dir_dy[d];
	if (nx < 0 || ny < 0 || nx >= m_sx || ny >= m_sy) { path_n = 0; return; }
	uint8_t cost = cell_cost(&bmap, (uint8_t)nx, (uint8_t)ny, u->z, d, STEP_TU);
	if (u->tu < cost) { path_n = 0; return; }
	uint8_t ox = u->x, oy = u->y, oz = u->z;   // откуда ушёл — эту клетку тоже перерисовать
	u->z = cell_step_z(&bmap, ox, oy, oz, (uint8_t)nx, (uint8_t)ny);   // лестница вверх, падение вниз
	u->x = (uint8_t)nx; u->y = (uint8_t)ny;
	u->tu -= cost;
	if (u->en > 1) u->en--;              // энергия тратится медленнее времени
	path_i++;
	if (path_i >= path_n) path_n = 0;
	if (u->z != oz) {                    // сменился этаж — камера едет за бойцом (Camera::setViewLevel)
		level = u->z;
		dl_ok = 0;
		ui_dirty(0);
		return;
	}
	// Перерисовываем не весь вид и даже не полосу, а две клетки — ту, откуда боец ушёл, и
	// ту, где оказался (17 §2). Гасится и собирается заново только их прямоугольник.
	uint8_t nxx = u->x, nyy = u->y;
	cell_repaint(ox, oy);
	cell_repaint(nxx, nyy);
}

// ---------------------------------------------------------------- сгенерированная карта
// Генератор (mapgen.c, банк 29) собирает поле из блоков террейна, а здесь собирается всё,
// что нужно для показа: таблица частей (tile_tab) и тайлсеты наборов в своих страницах.
// Номер части в клетке — как в MAP оригинала: 0 пусто, иначе номер части миссии; рендер
// берёт tile_tab[t - 1], поэтому часть t кладётся в строку t - 1.
#define GEN_SETS 16              // столько же, сколько у генератора (MAX_SETS)
static uint8_t gen_mode;                 // 1 — показывается сгенерированная карта
static uint8_t gen_page[GEN_SETS], gen_np[GEN_SETS], gen_ns;

static void gen_free(void)
{
	for (uint8_t i = 0; i < gen_ns; i++)
		if (gen_page[i] != PG_NONE) pg_free(gen_page[i], gen_np[i]);
	gen_ns = 0;
}

static uint8_t load_gen(uint16_t terrain)
{
	gen_free();
	loaded = 0;
	// Параметры миссии: размер поля, этажи, скрипт и террейн — из развёртывания, если оно
	// задано геоскейпом; корабль отряда и НЛО — от цели, иначе первые попавшиеся (отладка).
	uint8_t mods = 4, levels = 4;
	if (mis_deploy != 0xFFFF) {
		uint16_t t = mapgen_deploy(mis_deploy, &mods, &levels);
		if (t != 0xFFFF) terrain = t;
	}
	mapgen_set_extra(mis_craft != 0xFFFF ? mis_craft : mapgen_find_kind(1),
			 mis_ufo != 0xFFFF ? mis_ufo : mapgen_find_kind(2));
	if (!mapgen_run(terrain, mods, levels)) return 0;
	tiles_req_t q;
	mapgen_sets(q.set, q.tset, &q.ns);
	mapgen_used(q.used);                 // какие части реально попали на карту
	q.page = pf_page;
	uint8_t pages[GEN_SETS], nps[GEN_SETS], npg = 0, nd = 0;
	uint16_t nparts = tiles_load(&q, pages, nps, &npg, &nd);
	if (!npg) return 0;
	// Таблицы собраны в дальней памяти — переносим их к себе в банк (вид частей и смещения
	// нужны в каждом кадре, дальнее чтение тут не годится).
	far_read(FAR(pf_page + 1, TL_TILES), tile_tab, sizeof tile_tab);
	far_read(FAR(pf_page + 1, TL_YOFS), tile_y, sizeof tile_y);
	for (uint8_t i = 0; i < npg; i++) { gen_page[i] = pages[i]; gen_np[i] = nps[i]; }
	gen_ns = npg;
	ndoors = nd;
	if (!gen_ns) return 0;
	m_sx = (uint8_t)mapgen_sx(); m_sy = (uint8_t)mapgen_sy(); m_sz = mapgen_sz();
	m_nt = (uint8_t)nparts;
	cells = mapgen_cells();
	map_phys = cells;
	bmap.cells = cells; bmap.sx = m_sx; bmap.sy = m_sy; bmap.sz = m_sz; bmap.page = pf_page;
	level = 0;                           // камера начинается на земле, как в оригинале
	gen_mode = 1;
	dl_ok = 0;
	// Отряд: экипаж корабля миссии со своими показателями (units.c), а когда бой отладочный
	// (корабля нет) — шесть фигур. Лист брони X-COM: TDXCOM_0 у TFTD, XCOM_0 у UFO.
	if (load_unit_sheet(res_game() == 2 ? RES_UNIT_TDXCOM_0 : RES_UNIT_XCOM_0)) place_squad(6);
	else nunits = 0;
	sel = 0;
	center();
	if (nunits) center_on_unit();        // камера на первого бойца отряда
	loaded = 1;
	return 1;
}

// Перерисовать кусок вида: гасим прямоугольник кольца и собираем в него заново все клетки,
// которые его задевают. Гасить приходится потому, что тайлы кладутся прозрачным блитом
// (BLT1 пропускает цвет 0) — без гашения под новой картинкой остаётся старая.
// Прямоугольник собирается в запасной полосе холста интерфейса с обрезкой блитов по его
// строкам, а в кольцо уходят только его столбцы — одним DMA. Так клетки, задевающие его краем,
// рисуются целиком (иначе их не обрезать: блит DMA — прямоугольник), но то, что легло мимо
// столбцов прямоугольника, в кольцо не попадает и не затирает стоящее перед ним. Гашение тоже
// не видно: прежняя картинка в кольце остаётся до самой копии.
// До 2026-11-13 полоса по X рисовалась прямо в буфер и брала клетки на TILE_W шире: они ложились
// поверх готовых соседей без клеток перед ними — у левого края при скролле влево задние клетки
// перекрывали передние (диагональные полосы).
// direct — рисовать прямо в кольцо (полная перерисовка: она в половине кольца, которой не видно).
static void draw_rect(int16_t lo, int16_t hi, int16_t y0, int16_t y1, uint8_t direct)
{
	if (y0 > y1) return;
	uint16_t rows = (uint16_t)(y1 - y0 + 1);
	// Сборка берёт клетки, чьи спрайты задевают столбцы [lo, hi], а части с P_Level подняты
	// вверх (до 24 точек), поэтому клетки ниже прямоугольника тоже могут в него нарисовать —
	// их и добираем снизу. Список собирается до гашения: пока он собирается, на экране прежняя
	// картинка.
	clip_y0 = y0;
	clip_y1 = y1 + 24;
	win_y0 = y0;
	win_y1 = y1 + 1;
	to_scr = !direct;
	build_range(lo, hi);
	to_scr = 0;
	if (!direct) {
		far_t t = FAR(SCREEN_PAGE + (SCRATCH_Y >> 5), (SCRATCH_Y & 31) << 9);
		dma_cols(DMA_FILL | DMA_D_ALGN | DMA_ASZ, lo, hi, t, t, rows);
		dl_run();
		dma_wait();
		ring_cols(DMA_RAM_RAM | DMA_S_ALGN | DMA_D_ALGN | DMA_ASZ, lo, hi, y0, rows, t);
	} else {
		ring_cols(DMA_FILL | DMA_D_ALGN | DMA_ASZ, lo, hi, y0, rows, 0);
		dl_run();
		dma_wait();
	}
}

static void draw_strip(int16_t lo, int16_t hi)
{
	draw_rect(lo, hi, vy_lo, vy_hi, 0);
}

// Перерисовать клетку (её спрайт 32x40) — столько и трогаем при переезде курсора и шаге бойца
static void cell_repaint(uint8_t x, uint8_t y)
{
	if (!dl_ok || dl_page == PG_NONE) { ui_dirty(0); return; }
	int16_t wx = ((int16_t)x - (int16_t)y) * 16;
	int16_t y0 = ((int16_t)x + (int16_t)y) * 8 - (int16_t)level * 24 + yorg, y1 = y0 + TILE_H - 1;
	if (y0 < vy_lo) y0 = vy_lo;          // за нарисованным — не трогать: кольцо там чужое
	if (y1 > vy_hi) y1 = vy_hi;
	draw_rect(wx, wx + TILE_W - 1, y0, y1, 0);
}

static void draw_map(void)
{
	if (!loaded || dl_page == PG_NONE) return;
	int16_t vt = yorg - cam_y;           // строка R верха окна
	// Камера прыгнула дальше нарисованного (автоповтор накопился) — проще собрать заново
	if (dl_ok && (vt + VIEW_H + Y_AHEAD <= vy_lo || vt - Y_AHEAD > vy_hi)) dl_ok = 0;
	if (!dl_ok) {
		// Полная перерисовка — в половину кольца, которой сейчас не видно: прежний вид стоит на
		// экране, пока новый собирается, и сменяется им за один кадр (show_cam).
		vt = (int16_t)((map_gy + RING / 2) & (RING - 1));
		yorg = cam_y + vt;
		vx_lo = -cam_x - PAD_X;              // окно плюс запас с обеих сторон
		vx_hi = -cam_x + SCREEN_W - 1 + PAD_X;
		vy_lo = vt - PAD_Y;
		vy_hi = vt + VIEW_H - 1 + PAD_Y;
		draw_rect(vx_lo, vx_hi, vy_lo, vy_hi, 1);
		dl_ok = 1;
		show_cam();
		return;
	}
	// Камера ушла по горизонтали — дорисовать въехавшую полосу на всю нарисованную высоту
	int16_t lo = -cam_x - TILE_W, hi = -cam_x + SCREEN_W - 1;
	if (lo < vx_lo) { draw_strip(lo, vx_lo - 1); vx_lo = lo; }
	if (hi > vx_hi) { draw_strip(vx_hi + 1, hi); vx_hi = hi; }
	if (vx_hi - vx_lo > BUF_W - TILE_W) {   // в кольцо больше не влезает — забыть дальний край
		if (hi > vx_hi - 8) vx_lo = vx_hi - (BUF_W - TILE_W);
		else vx_hi = vx_lo + (BUF_W - TILE_W);
	}
	// По вертикали — то же полосой строк на всю нарисованную ширину, с запасом Y_AHEAD за краем
	// окна: полоса собирается заранее, пока её ещё не видно.
	int16_t top = vt - Y_AHEAD, bot = vt + VIEW_H - 1 + Y_AHEAD;
	if (top < vy_lo) {
		int16_t n = vy_lo - Y_BAND;
		if (n > top) n = top;
		draw_rect(vx_lo, vx_hi, n, vy_lo - 1, 0);
		vy_lo = n;
		if (vy_hi - vy_lo > VY_MAX) vy_hi = vy_lo + VY_MAX;
	}
	if (bot > vy_hi) {
		int16_t n = vy_hi + Y_BAND;
		if (n < bot) n = bot;
		draw_rect(vx_lo, vx_hi, vy_hi + 1, n, 0);
		vy_hi = n;
		if (vy_hi - vy_lo > VY_MAX) vy_lo = vy_hi - VY_MAX;
	}
	show_cam();
}

// Замеры DMA (клавиши B/N/V) убраны: их числа записаны в 16 §8.3, а место в банке нужно
// под сам бой.

// Панель бойца рисует банк 30 (units.c): в банке боя место кончилось
static void draw_panel(void)
{
	bpanel_t p;
	const unit_t *u = &units[sel < nunits ? sel : 0];
	p.n = nunits; p.level = level;
	p.tu = u->tu; p.tu_max = u->tu_max; p.en = u->en;
	p.hp = u->hp; p.hp_max = u->hp_max; p.mor = u->mor;
	bat_panel(&p);
}

static void draw_all(void)
{
	draw_map();                          // гасит экран сам — прямо перед отрисовкой
	draw_panel();
}

// Геоскейп сообщает, какая миссия начинается: развёртывание (state.h site_t.deployment),
// террейн НЛО и террейн корабля отряда; #FFFF — не задано.
void bat_mission(uint16_t deploy, uint16_t ufo, uint16_t craft_map, uint16_t crew) __banked
{
	mis_deploy = deploy;
	mis_ufo = ufo;
	mis_craft = craft_map;
	mis_crew = crew;
}

uint8_t bat_get(uint8_t id, sdef_t *s, wdef_t *w) __banked
{
	return scr_find(tab, sizeof tab / sizeof tab[0], id, s, w);
}

void bat_text(uint8_t id, uint8_t slot, uint8_t line, char *buf) __banked
{
	(void)id; (void)slot; (void)line;
	buf[0] = 0;
}

uint8_t bat_rows(uint8_t id, uint8_t slot) __banked
{
	(void)id; (void)slot;
	return 0;
}

uint8_t bat_event(uint8_t id, uint8_t ev, uint8_t arg) __banked
{
	(void)id;
	switch (ev) {
	case EVT_MUSIC: {
		// Тема боя: роль MK_TACTIC из таблицы MUSGRP (22 §1.3), как GMTACTIC в оригинале
		uint16_t id = mus_kind(MK_TACTIC);
		if (id) mus_play(id);
		break;
	}
	case EVT_OPEN:
		if (dl_page == PG_NONE) dl_page = pg_alloc(2, 1);   // список вида: две страницы подряд
		if (pf_page == PG_NONE) pf_page = pg_alloc(2, 1);   // рабочая память боя: поиск пути и таблицы
		if (pf_page == PG_NONE) { dbg_puts("battle: no pages\n"); break; }   // иначе — в страницу #FF
		// Карта миссии собирается генератором (16 §3). Пока миссии нет, террейн берётся
		// по очереди — клавиша G дальше пересобирает карту следующего террейна.
		load_gen(gen_terrain);               // карта миссии: генератор (16 §3)
		split_start();
		cursor_sheet(CUR_SHEET);             // листы TSU — под холст карты (см. «Сплит-экран»)
		// У боя своя палитра: цвета #F0..#FF в ней тёмные, и курсор в них не виден.
		// В оригинале у боя свой цвет курсора (Mod::BATTLESCAPE_CURSOR = 144).
		cursor_color(CURSOR_BATTLESCAPE);
		load_cursor();                   // рамка клетки из CURSOR.PCK (рисуется вместе с картой)
		cur_on = 0;
		break;
	case EVT_TICK:
		// Курсор клетки: рамка вокруг клетки под мышью. Она часть картинки карты (задняя
		// половина под содержимым клетки, передняя поверх), поэтому при переезде на другую
		// клетку перерисовываются только две клетки — прежняя и новая.
		if (gen_mode && loaded) {
			uint8_t cx = 0, cy = 0, on = 0;
			if (cursor_y < VIEW_H && screen_to_cell(cursor_x, cursor_y, &cx, &cy)) on = 1;
			uint8_t ox = cur_cx, oy = cur_cy, oon = cur_on;
			if (on != oon || (on && (cx != ox || cy != oy))) {
				cur_cx = cx; cur_cy = cy; cur_on = on;
				if (oon) cell_repaint(ox, oy);
				if (on) cell_repaint(cx, cy);
			}
		}
		if (turn_dir != 0xFF && nunits) {    // правая кнопка: разворот по одной восьмой,
			unit_t *u = &units[sel < nunits ? sel : 0];   // в конце — попытка открыть дверь
			if (move_wait) move_wait--;
			else if (u->dir != turn_dir) { turn_to(u, turn_dir); move_wait = 2; }
			else { door_try(u, turn_dir, 1); turn_dir = 0xFF; ui_dirty(0); }
		} else if (path_n) {                 // идём по пути: шаг раз в несколько кадров
			if (move_wait) move_wait--;
			else { step_unit(); move_wait = 3; if (!path_n) ui_dirty(0); }   // в конце — обновить панель
		}
		break;
	case EVT_DRAW:
		draw_all();
		break;
	case EVT_CLOSE:
		// Бой отдаёт всю свою память: карту, наборы тайлов, лист юнитов, список вида и
		// рабочую память поиска пути. Иначе геоскейпу не из чего заводить слоты кэша, и он
		// перечитывает каждый фон с карты — экран залипает (14 §todo).
		split_stop();
		cur_on = 0;
		if (cur_page != PG_NONE) { pg_free(cur_page, cur_np); cur_page = PG_NONE; }
		cursor_sheet(TSU_PAGE);
		cursor_color(CURSOR_GEOSCAPE);   // вернуть цвет курсора геоскейпа
		gen_free();
		if (unit_page != PG_NONE) { pg_free(unit_page, unit_np); unit_page = PG_NONE; }
		mapgen_free();
		gen_mode = 0;
		loaded = 0;
		nunits = 0;
		if (dl_page != PG_NONE) { pg_free(dl_page, 2); dl_page = PG_NONE; dl_ok = 0; }
		if (pf_page != PG_NONE) { pg_free(pf_page, 2); pf_page = PG_NONE; }
		path_n = 0;
		turn_dir = 0xFF;
		// Запасная полоса перерисовки клеток (строки 456..511) лежит в заднем буфере глобуса
		// (globe.s, BACK_Y 280): после боя геоскейп обязан нарисовать планету заново, иначе на
		// экране остаются следы поля боя.
		globe_invalidate();
		globe_det_reset();
		gview_reset();
		globe_prepare();                 // собрать планету в задний буфер целиком, поверх следов боя
		break;
	case EVT_BUTTON:
		switch (arg) {
		case 0: {                            // клик по карте
			if (!gen_mode || !nunits || cursor_y >= VIEW_H) break;
			uint8_t tx, ty;
			if (!screen_to_cell(cursor_x, cursor_y, &tx, &ty)) break;
			unit_t *u = &units[sel < nunits ? sel : 0];
			if (ui_arrow_max) {              // правая кнопка: развернуться туда и открыть дверь
				path_n = 0;
				turn_dir = dir_to((int16_t)tx - (int16_t)u->x, (int16_t)ty - (int16_t)u->y);
				move_wait = 0;
				break;
			}
			uint8_t no = unit_no(u->z, ty, tx);
			if (no && no - 1 != sel) {       // свой боец — выбрать его (primaryAction оригинала)
				sel = (uint8_t)(no - 1);
				path_n = 0;
				ui_dirty(0);
				break;
			}
			pf_req_t q = { cells, m_sx, m_sy, u->z, m_sz, u->x, u->y, tx, ty, PF_BUDGET, STEP_TU, pf_page };
			path_n = pf_find(&q, path, PATH_MAX);
			path_i = 0;
			move_wait = 0;
			break;
		}
		case 1: sel_prev(); break;           // боец выше по списку (и камера на него)
		case 2: sel_next(); break;
		case 3: if (level + 1 < m_sz) { level++; center(); ui_dirty(0); } break;
		case 4: if (level) { level--; center(); ui_dirty(0); } break;
		case 5: UI_GO(A_PUSH, SCR_INVENTORY); break;
		case 6: center_on_unit(); ui_dirty(0); break;
		case 7: sel_next(); break;           // следующий боец
		case 10: do_kneel(); break;          // присесть и встать
		case 9:                              // «1/2»: все этажи или только текущий
			all_levels = !all_levels;
			dl_ok = 0;
			ui_dirty(0);
			break;
		case 8:                              // конец хода: время и энергия бойцов восстанавливаются
			for (uint8_t i = 0; i < nunits; i++) { units[i].tu = units[i].tu_max; units[i].en = units[i].tu_max; }
			ui_dirty(0);
			break;
		}
		break;
	case EVT_KEY: {
		// Автоповтор за время долгой перерисовки копится (in_reps) — сдвигать сразу на все
		// шаги, иначе после отпускания клавиши вид ещё несколько раз перерисовывается.
		// Шаг один по обеим осям, как в оригинале (Camera::keyboardPress: battleScrollSpeed
		// и по X, и по Y); до 2026-11-13 по Y был вдвое меньше — вертикаль ползла.
		int16_t n = in_reps ? in_reps : 1;
		int16_t ox = cam_x, oy = cam_y;
		switch (arg) {
		case KEY_LEFT:  cam_x += SCROLL_STEP * n; clamp_cam(); break;
		case KEY_RIGHT: cam_x -= SCROLL_STEP * n; clamp_cam(); break;
		case KEY_UP:    cam_y += SCROLL_STEP * n; clamp_cam(); break;
		case KEY_DOWN:  cam_y -= SCROLL_STEP * n; clamp_cam(); break;
		case 'q': case 'Q': if (level + 1 < m_sz) { level++; center(); } break;
		case 'd': case 'D': {               // отладка: поставить бойца к первой двери
			uint8_t dx, dy, ds;
			if (!gen_mode || !nunits || !door_find(&bmap, level, &dx, &dy, &ds)) break;
			unit_t *u = &units[sel < nunits ? sel : 0];
			uint8_t ox = u->x, oy = u->y;
			u->x = dx; u->y = dy; u->z = level;
			u->dir = ds == 1 ? 6 : 0;         // западная стена — лицом на запад, северная — на север
			path_n = 0;
			cell_repaint(ox, oy);
			dbg_puts("door: at "); dbg_dec(dx); dbg_puts(","); dbg_dec(dy);
			dbg_puts(" slot "); dbg_dec(ds); dbg_puts("\n");
			center_on_unit();
			break;
		}
		case 'k': case 'K': do_kneel(); break;   // присесть и встать (в оригинале K)
		case 'n': sel_next(); break;         // следующий боец (в оригинале TAB)
		case 'N': sel_prev(); break;         // предыдущий (в оригинале SHIFT)
		case 'a': case 'A': if (level) { level--; center(); } break;
		case 'g': case 'G': {
			// Собрать карту очередного террейна генератором и показать её (16 §3)
			uint8_t ok = load_gen(gen_terrain);
			dbg_puts("mapgen: terrain ");
			dbg_dec(gen_terrain);
			dbg_puts(ok ? " ok " : " FAIL ");
			dbg_puts(" dl "); dbg_dec(dl_n); dbg_puts(" units "); dbg_dec(nunits); dbg_puts(" doors "); dbg_dec(ndoors);
			dbg_puts("\n");
			gen_terrain++;
			ui_dirty(0);
			break;
		}
		default: return 0;
		}
		if (cam_x == ox && cam_y == oy && (arg == KEY_LEFT || arg == KEY_RIGHT || arg == KEY_UP || arg == KEY_DOWN))
			break;                       // камера упёрлась в край карты — перерисовывать нечего
		ui_dirty(0);
		break;
	}
	}
	return 0;
}
