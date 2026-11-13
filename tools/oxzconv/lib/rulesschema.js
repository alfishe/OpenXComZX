// Rule table schema: fields, kinds, defaults (from the OpenXcom constructors —
// project_docs/10_rules_reference.md), record order (OpenXcom sortLists).
// Table resource id = RES_BASE + position in the list; RES_RULE_VARS = RES_BASE - 1.
// Do not reorder tables or fields without rebuilding the engine (rules.h is generated from here).
'use strict';
const Y = require('./yaml');
const { ordinal } = require('./text');
const { leBytes } = require('./csmath');

const RES_BASE = 0x0040;
const STR_NONE_ITEM = '65534';       // armors.storeItem: #FFFE — STR_NONE (infinite)
const OBJECTIVE_SITE = 3;
const DEPLOYMENT_FLAG = 0x4000;
const NVARS = 2;                     // state.h
const SLOT_GRID = 4;                 // invs mask: bit (y * 4 + x)
const DIFFICULTY_LEVELS = 5;
const NONE = 0xFFFF;

const F = (name, kind, def = null, cname = null, comment = null) => ({ name, kind, def, cname, comment, fn: null });
const Fn = (cname, kind, fn, comment = null) => ({ name: null, kind, def: null, cname, comment, fn });
// F with a comment only (C# named argument "comment:")
const Fc = (name, kind, def, comment) => F(name, kind, def, null, comment);

// Default name = record key (name: for items, title: for articles etc.)
const Name = (field = 'name') => Fn('name', 'str', (e, k) => Y.get(e, field) ?? k, 'строка названия');

const T = o => ({ section: null, key: 'type', comment: null, sortByKey: false, sort: null, source: null, flags: [], ...o });

function tables() {
	const t = [];

	t.push(T({
		name: 'items', comment: 'предметы',
		fields: [
			Name(),
			F('requires', 'refs:research'),
			F('size', 'x100', '0'),
			F('costBuy', 'u32', '0'), F('costSell', 'u32', '0'),
			F('transferTime', 'u8', '24'), F('weight', 'u8', '3'),
			F('bigSprite', 'i16', '-1'), F('floorSprite', 'i16', '-1'), F('handSprite', 'i16', '120'),
			Fc('bulletSprite', 'i16', '-1', 'значение YAML; OpenXcom хранит *35'),
			F('fireSound', 'i16', '-1'), F('hitSound', 'i16', '-1'), F('hitAnimation', 'i16', '-1'),
			F('meleeSound', 'i16', '39'), F('meleeHitSound', 'i16', '-1'), F('meleeAnimation', 'i16', '0'),
			F('power', 'u16', '0'), F('meleePower', 'u16', '0'),
			F('compatibleAmmo', 'refs:items'),
			Fc('damageType', 'u8', '0', 'ItemDamageType'), Fc('battleType', 'u8', '0', 'BattleType'),
			F('accuracyAuto', 'u8', '0'), F('accuracySnap', 'u8', '0'), F('accuracyAimed', 'u8', '0'), F('accuracyMelee', 'u8', '0'),
			F('tuAuto', 'u8', '0'), F('tuSnap', 'u8', '0'), F('tuAimed', 'u8', '0'), F('tuMelee', 'u8', '0'), F('tuUse', 'u8', '0'),
			Fc('clipSize', 'i16', '0', '-1 — бесконечно'),
			F('waypoints', 'u8', '0'), F('invWidth', 'u8', '1'), F('invHeight', 'u8', '1'),
			F('painKiller', 'u8', '0'), F('heal', 'u8', '0'), F('stimulant', 'u8', '0'),
			F('woundRecovery', 'u8', '0'), F('healthRecovery', 'u8', '0'), F('stunRecovery', 'u8', '0'), F('energyRecovery', 'u8', '0'),
			F('recoveryPoints', 'i16', '0'), F('armor', 'u8', '20'), F('turretType', 'i8', '-1'),
			Fc('blastRadius', 'i8', '-1', '-1 — вычислить по power/damageType'),
			F('attraction', 'u8', '0'), F('autoShots', 'u8', '3'), F('shotgunPellets', 'u8', '0'),
			F('maxRange', 'u8', '200'), F('aimRange', 'u8', '200'), F('snapRange', 'u8', '15'), F('autoRange', 'u8', '7'),
			F('minRange', 'u8', '0'), F('dropoff', 'u8', '2'), F('bulletSpeed', 'u8', '0'), F('explosionSpeed', 'u8', '0'),
			F('specialType', 'i8', '-1'), F('vaporColor', 'i8', '-1'), F('vaporDensity', 'u8', '0'), F('vaporProbability', 'u8', '15'),
			F('zombieUnit', 'ref:units'),
			Fn('sortRank', 'u16', (e, k, rs) => String(rs.sortRank('items', k)),
				'место id в std::map: груз корабля ложится на землю инвентаря в этом порядке (ItemContainer)'),
		],
		flags: ['twoHanded', 'fixedWeapon', 'recover=true', 'liveAlien', 'flatRate', 'arcingShot', 'strengthApplied',
			'skillApplied=true', 'LOSRequired', 'underwaterOnly', 'landOnly', 'ignoreInBaseDefense'],
	}));

	t.push(T({
		name: 'research', key: 'name', comment: 'исследования',
		fields: [
			Name(),
			F('cost', 'u16', '0'), F('points', 'u16', '0'),
			F('dependencies', 'refs:research'), F('unlocks', 'refs:research'), F('getOneFree', 'refs:research'),
			F('requires', 'refs:research'),
			F('lookup', 'ref:research'),
			Fn('item', 'ref:items', (e, k, rs) => (rs.index.get('items').has(k) ? k : null), 'предмет с тем же id (needItem)'),
		],
		flags: ['needItem', 'destroyItem', 'unlockFinalMission'],
	}));

	t.push(T({
		name: 'manufacture', key: 'name', comment: 'производство',
		fields: [
			Name(),
			F('category', 'str'),
			F('requires', 'refs:research'),
			F('space', 'u16', '0'), F('time', 'u16', '0'), F('cost', 'u32', '0'),
			F('requiredItems', 'refmap:items|crafts'),
			Fn('producedItems', 'refmap:items|crafts', (e, k) => Y.get(e, 'producedItems') ?? new Map([[Y.str(Y.get(e, 'name')) ?? k, '1']]),
				'по умолчанию {name: 1}'),
		],
	}));

	t.push(T({
		name: 'facilities', comment: 'постройки базы',
		fields: [
			Name(),
			F('requires', 'refs:research'),
			F('spriteShape', 'i16', '-1'), F('spriteFacility', 'i16', '-1'),
			F('size', 'u8', '1'),
			F('buildCost', 'u32', '0'), F('buildTime', 'u16', '0'), F('monthlyCost', 'u32', '0'),
			F('storage', 'u16', '0'), F('personnel', 'u16', '0'), F('aliens', 'u16', '0'), F('crafts', 'u8', '0'),
			F('labs', 'u16', '0'), F('workshops', 'u16', '0'), F('psiLabs', 'u8', '0'),
			F('radarRange', 'u16', '0'), F('radarChance', 'u8', '0'),
			F('defense', 'u16', '0'), F('hitRatio', 'u8', '0'), F('fireSound', 'i16', '0'), F('hitSound', 'i16', '0'),
		],
		flags: ['lift', 'hyper', 'mind', 'grav'],
	}));

	t.push(T({
		name: 'crafts', comment: 'корабли',
		fields: [
			Name(),
			F('requires', 'refs:research'),
			F('sprite', 'i16', '-1'), F('marker', 'i8', '-1'),
			F('fuelMax', 'u16', '0'), F('damageMax', 'u16', '0'), F('speedMax', 'u16', '0'), F('accel', 'u8', '0'),
			F('weapons', 'u8', '0'), F('soldiers', 'u8', '0'), F('vehicles', 'u8', '0'),
			F('costBuy', 'u32', '0'), F('costRent', 'u32', '0'), F('costSell', 'u32', '0'),
			F('refuelItem', 'ref:items'), F('repairRate', 'u8', '1'), F('refuelRate', 'u8', '1'),
			F('radarRange', 'u16', '672'), F('sightRange', 'u16', '1696'),
			F('transferTime', 'u16', '0'), F('score', 'i16', '0'),
			Fc('maxAltitude', 'i8', '-1', 'TFTD: > -1 — корабль «только вода»'), F('maxItems', 'u16', '0'),
			F('radarChance', 'u8', '100'),
		],
		flags: ['spacecraft'],
	}));

	t.push(T({
		name: 'craftWeapons', comment: 'оружие кораблей (порядок — по listOrder launcher)',
		sort: (rs, l) => stableOrderBy(l, kv => rs.listOrder('items', Y.str(Y.get(kv[1], 'launcher')))),
		fields: [
			Name(),
			F('sprite', 'i16', '-1'), F('sound', 'i16', '-1'),
			F('damage', 'u16', '0'), F('range', 'u16', '0'), F('accuracy', 'u8', '0'),
			F('reloadCautious', 'u8', '0'), F('reloadStandard', 'u8', '0'), F('reloadAggressive', 'u8', '0'),
			F('ammoMax', 'u16', '0'), F('rearmRate', 'u8', '1'), F('projectileType', 'u8', '2'), F('projectileSpeed', 'u8', '0'),
			F('launcher', 'ref:items'), F('clip', 'ref:items'),
		],
		flags: ['underwaterOnly'],
	}));

	t.push(T({
		name: 'armors', comment: 'броня (порядок — по listOrder storeItem, без предмета — первыми)',
		sort: (rs, l) => stableOrderBy(l, kv => rs.listOrder('items', Y.str(Y.get(kv[1], 'storeItem')))),
		section: 'armors',
		fields: [
			Name('type'),
			Fn('storeItem', 'u16', (e, k, rs) => (Y.str(Y.get(e, 'storeItem')) === 'STR_NONE' ? STR_NONE_ITEM
				: String(rs.ref('items', Y.get(e, 'storeItem'), `armors.${k}.storeItem`))), 'предмет; #FFFE — STR_NONE (бесконечно), #FFFF — нет'),
			Fn('corpseGeo', 'ref:items', e => Y.get(e, 'corpseItem') ?? Y.get(e, 'corpseGeo') ?? firstOrNull(Y.list(Y.get(e, 'corpseBattle')))),
			Fn('corpseBattle', 'refs:items', e => (Y.get(e, 'corpseItem') !== null ? [Y.get(e, 'corpseItem')] : Y.get(e, 'corpseBattle'))),
			F('frontArmor', 'u8', '0'), F('sideArmor', 'u8', '0'), F('rearArmor', 'u8', '0'), F('underArmor', 'u8', '0'),
			F('drawingRoutine', 'u8', '0'), F('movementType', 'u8', '0'), F('size', 'u8', '1'), F('weight', 'u8', '0'),
			F('deathFrames', 'u8', '3'), F('forcedTorso', 'u8', '0'),
			Fc('damageModifier', 'nums100', null, '10 x i16 * 100; нет элемента — 100'),
			Fn('invImage', 'res', (e, k, rs) => armorImage(rs, k, 5), 'кукла инвентаря: spriteInv + M0.SPK / .SPK'),
			F('stats', 'stats'),
			Fc('spriteInv', 'str', null, 'имя куклы инвентаря (MAN_*), пока через таблицу строк'),
		],
		flags: ['allowInv=true', 'constantAnimation', 'drawBubbles'],
	}));

	t.push(T({
		name: 'soldiers', comment: 'типы солдат',
		fields: [
			Fn('name', 'str', (e, k) => (k === 'XCOM' ? 'STR_SOLDIER' : k)),
			F('requires', 'refs:research'),
			F('minStats', 'stats'), F('maxStats', 'stats'), F('statCaps', 'stats'),
			F('armor', 'ref:armors'),
			F('costBuy', 'u32', '0'), F('costSalary', 'u32', '0'),
			F('standHeight', 'u8', '0'), F('kneelHeight', 'u8', '0'), F('floatHeight', 'u8', '0'),
			F('femaleFrequency', 'u8', '50'), F('value', 'u8', '20'), F('transferTime', 'u8', '0'),
		],
	}));

	t.push(T({
		name: 'units', comment: 'юниты (порядок — по ключу, std::map)', sortByKey: true,
		fields: [
			Name('type'),
			F('race', 'str'), F('rank', 'str'),
			F('stats', 'stats'),
			F('armor', 'ref:armors'),
			F('standHeight', 'u8', '0'), F('kneelHeight', 'u8', '0'), F('floatHeight', 'u8', '0'),
			F('value', 'u16', '0'), F('intelligence', 'u8', '0'), F('aggression', 'u8', '0'),
			F('energyRecovery', 'u8', '30'), F('specab', 'u8', '0'),
			F('spawnUnit', 'ref:units'), F('meleeWeapon', 'ref:items'),
		],
		flags: ['livingWeapon', 'capturable=true'],
	}));

	t.push(T({
		name: 'alienRaces', key: 'id', comment: 'расы: члены по рангам 0..7',
		fields: [Name('id'), F('members', 'refs:units')],
	}));

	t.push(T({
		name: 'countries', comment: 'страны (двоичные углы; широта < 0 — север)',
		fields: [
			Name('type'),
			F('fundingBase', 'u16', '0'), F('fundingCap', 'u16', '0'),
			F('labelLon', 'lon', '0'), F('labelLat', 'lat', '0'),
			F('areas', 'areas'),
		],
	}));

	t.push(T({
		name: 'regions', comment: 'регионы (зоны — двоичные углы)',
		fields: [
			Name('type'),
			F('cost', 'u32', '0'), F('regionWeight', 'u16', '0'),
			F('areas', 'areas'),
			Fn('missionWeights', 'nums', (e, k, rs) => weights(rs, 'alienMissions', Y.get(e, 'missionWeights'), `regions.${k}.missionWeights`),
				'WeightedOptions: пары (alienMissions, вес) по имени миссии'),
			F('missionRegion', 'ref:regions'),
			Fn('zones', 'nums', (e, k, rs) => rs.cache.get('zoneStarts').get(k).slice(),
				'missionZones: начала зон в zoneAreas, последний — конец (зон = n - 1)'),
			Fn('sortRank', 'u8', (e, k, rs) => String(rs.sortRank('regions', k)), 'место имени в std::map (порядок выбора WeightedOptions)'),
		],
	}));

	t.push(T({
		name: 'ufos', comment: 'НЛО / USO',
		fields: [
			Name('type'),
			F('size', 'str', 'STR_VERY_SMALL'),
			Fn('radius', 'u8', e => {
				const s = Y.str(Y.get(e, 'size')) ?? 'STR_VERY_SMALL';
				return s === 'STR_VERY_SMALL' ? '2' : s === 'STR_SMALL' ? '3' : s === 'STR_MEDIUM_UC' ? '4' : s === 'STR_LARGE' ? '5' : s === 'STR_VERY_LARGE' ? '6' : '0';
			}, 'радиус в перехвате'),
			F('sprite', 'i16', '-1'), F('marker', 'i8', '-1'), F('markerLand', 'i8', '-1'), F('markerCrash', 'i8', '-1'),
			F('damageMax', 'u16', '0'), F('speedMax', 'u16', '0'), F('power', 'u16', '0'), F('range', 'u16', '0'),
			F('score', 'i16', '0'), F('reload', 'u16', '0'), F('breakOffTime', 'u16', '0'),
			F('sightRange', 'u16', '268'), F('missionScore', 'u16', '1'),
		],
	}));

	t.push(T({
		name: 'ufopaedia', key: 'id', comment: 'статьи Уфопедии (порядок — раздел, затем listOrder)',
		sort: (rs, l) => {
			const sec = new Map();
			l.forEach((kv, i) => { const s = Y.str(Y.get(kv[1], 'section')) ?? ''; if (!sec.has(s)) sec.set(s, i); });
			return stableOrderBy(l, kv => sec.get(Y.str(Y.get(kv[1], 'section')) ?? ''));
		},
		fields: [
			Name('title'),
			F('section', 'str'),
			F('type_id', 'u8', '0', 'type', 'UFOPAEDIA_TYPE_*: 1..9 UFO, 10..17 TFTD'),
			Fn('image', 'res', (e, k, rs) => Y.get(e, 'image_id') ?? armorImage(rs, k, Y.int(Y.get(e, 'type_id'))), 'картинка; UFO броня (тип 5) — кукла spriteInv+M0.SPK / .SPK'),
			F('text', 'str'),
			F('weapon', 'str'),
			Fn('textWidth', 'u16', e => Y.get(e, 'text_width') ?? (Y.int(Y.get(e, 'type_id')) >= 10 ? '157' : '0')),
			F('requires', 'refs:research'),
			Fn('rectStats', 'nums', e => rectList(Y.get(e, 'rect_stats')), 'x, y, w, h'),
			Fn('rectText', 'nums', e => rectList(Y.get(e, 'rect_text')), 'x, y, w, h'),
			Fn('rule', 'u16', (e, k, rs) => String(articleRule(rs, k, Y.int(Y.get(e, 'type_id')))), 'номер записи в таблице по типу статьи'),
		],
	}));

	// ---- geoscape: alien strategy (14_todo §3.17). Lists are "nums" (i16 in the tail):
	// weighted — pairs (number, weight) in name order (WeightedOptions = std::map<std::string>),
	// per month — [month, n, (number, weight) x n] ... ascending month.
	t.push(T({
		name: 'invs', key: 'id', comment: 'секции инвентаря (inventories.rul): место на экране и сетка слотов',
		fields: [
			Name('id'),
			F('x', 'u16', '0'), F('y', 'u16', '0'),
			Fc('type', 'u8', '0', 'RuleInventory: 0 — сетка slots, 1 — рука (2x3), 2 — земля'),
			Fn('cols', 'u8', e => slotSize(e, 0), 'клеток в ширину (рука и земля — 0)'),
			Fn('rows', 'u8', e => slotSize(e, 1), 'клеток в высоту'),
			Fn('mask', 'u16', e => slotMask(e), 'занятые клетки сетки: бит (y * 4 + x)'),
		],
	}));

	t.push(T({
		name: 'ufoTrajectories', key: 'id', comment: 'траектории НЛО',
		fields: [
			Fc('groundTimer', 'u16', '5', 'на земле groundTimer * 5 с'),
			Fc('waypoints', 'nums', null, '[зона, высота 0..4, скорость %] x n'),
			Fn('assault', 'u8', (e, k) => (k === '__RETALIATION_ASSAULT_RUN' ? '1' : '0'), '__RETALIATION_ASSAULT_RUN'),
		],
	}));

	t.push(T({
		name: 'alienDeployments', comment: 'развёртывания: пока поля для геоскейпа (места миссий, базы пришельцев)',
		fields: [
			Name('type'),
			F('markerName', 'str', 'STR_TERROR_SITE'), F('markerIcon', 'i8', '-1'),
			Fn('durationMin', 'u8', e => elementAt(Y.list(Y.get(e, 'duration')), 0) ?? '0', 'часов'),
			Fn('durationMax', 'u8', e => elementAt(Y.list(Y.get(e, 'duration')), 1) ?? '0'),
			F('despawnPenalty', 'i16', '0'), F('points', 'i16', '0'),
			Fn('genMission', 'nums', (e, k, rs) => weights(rs, 'alienMissions', Y.get(e, 'genMission'), `alienDeployments.${k}.genMission`),
				'пары (alienMissions, вес)'),
			F('genMissionFreq', 'u8', '0'),
			F('alert', 'str', 'STR_ALIENS_TERRORISE'), F('alertBackground', 'res', 'BACK03.SCR'),
		],
	}));

	t.push(T({
		name: 'alienMissions', comment: 'миссии пришельцев',
		fields: [
			Name('type'),
			F('points', 'i16', '0'), Fc('objective', 'u8', '0', '0 SCORE, 1 INFILTRATION, 2 BASE, 3 SITE, 4 RETALIATION, 5 SUPPLY'),
			F('spawnUfo', 'ref:ufos'), F('spawnZone', 'i8', '-1'), F('retaliationOdds', 'i8', '-1'),
			F('siteType', 'ref:alienDeployments'),
			Fn('waves', 'nums', (e, k, rs) => waves(rs, Y.get(e, 'waves'), `alienMissions.${k}.waves`),
				'[ufo, count, trajectory, timer (мин), objective] x n; ufo: ufos | #4000 + alienDeployments | -1'),
			Fn('raceWeights', 'nums', (e, k, rs) => monthWeights(rs, 'alienRaces', Y.get(e, 'raceWeights'), `alienMissions.${k}.raceWeights`, true),
				'по месяцам: пары (alienRaces, вес)'),
			Fn('missionWeights', 'nums', e => {
				const l = [];
				const m = Y.map(Y.get(e, 'missionWeights'));
				if (m !== null) for (const [mk, mv] of stableOrderBy([...m], kv => Y.int(kv[0]))) l.push(Y.int(mk), Y.int(mv));
				return l;
			}, '[месяц, вес] x n (getWeight; нет — вес 1)'),
			Fn('sortRank', 'u8', (e, k, rs) => String(rs.sortRank('alienMissions', k)), 'место имени в std::map'),
		],
	}));

	t.push(T({
		name: 'missionScripts', comment: 'сценарий миссий по месяцам (determineAlienMissions)',
		fields: [
			F('firstMonth', 'i16', '0'), F('lastMonth', 'i16', '-1'), F('label', 'u8', '0'),
			F('conditionals', 'nums'),
			Fn('missionWeights', 'nums', (e, k, rs) => monthWeights(rs, 'alienMissions', Y.get(e, 'missionWeights'), `missionScripts.${k}.missionWeights`, false),
				'по месяцам: пары (alienMissions, вес)'),
			F('executionOdds', 'u8', '100'), F('targetBaseOdds', 'u8', '0'), Fc('startDelay', 'u16', '0', 'минут'),
			Fn('raceWeights', 'nums', (e, k, rs) => monthWeights(rs, 'alienRaces', Y.get(e, 'raceWeights'), `missionScripts.${k}.raceWeights`, false)),
			Fn('regionWeights', 'nums', (e, k, rs) => monthWeights(rs, 'regions', Y.get(e, 'regionWeights'), `missionScripts.${k}.regionWeights`, false)),
			F('minDifficulty', 'u8', '0'),
			Fn('researchTriggers', 'nums', (e, k, rs) => {
				const l = [];
				const m = Y.map(Y.get(e, 'researchTriggers'));
				if (m !== null) for (const [mk, mv] of stableOrderBy([...m], kv => Y.str(kv[0]), ordinal)) { l.push(rs.ref('research', mk, `missionScripts.${k}`)); l.push(Y.bool(mv) ? 1 : 0); }
				return l;
			}, '[research, 1 — исследовано / 0 — нет] x n'),
			F('maxRuns', 'i16', '-1'), F('avoidRepeats', 'u8', '0'),
			Fn('varIndex', 'i8', (e, k, rs) => String(varIndex(rs, Y.str(Y.get(e, 'varName')))), 'varName: номер в отсортированном списке имён, -1 — нет'),
			Fn('siteType', 'u8', (e, k, rs) => (scriptSiteType(rs, e) ? '1' : '0'), 'миссии с objective SITE (Mod: первая по имени)'),
		],
		flags: ['useTable=true'],
	}));

	t.push(T({
		name: 'zoneAreas', comment: 'области зон миссий всех регионов подряд (regions.zones — начала)', source: zoneAreas,
		fields: [
			F('lonMin', 'lon', '0'), F('lonMax', 'lon', '0'), F('latMin', 'lat', '0'), F('latMax', 'lat', '0'),
			Fc('texture', 'i8', '0', 'текстура глобуса (TFTD: -1 порт, -2 остров, -3 артефакт, -4 морской путь)'),
			Fc('name', 'str', null, 'город'),
		],
	}));

	t.push(T({
		name: 'globeTextures', key: 'id', comment: 'текстуры глобуса: развёртывания мест миссий (globe.textures)', source: globeTextures,
		fields: [
			F('id', 'i8', '0'),
			Fn('deployments', 'nums', (e, k, rs) => weights(rs, 'alienDeployments', Y.get(e, 'deployments'), `globe.textures.${k}`), 'пары (alienDeployments, вес)'),
		],
	}));

	return t;
}

// Enumerable.OrderBy: stable, by key (numbers ascending, or with a comparator)
function stableOrderBy(list, keyFn, cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)) {
	return list.map((x, i) => ({ x, i, k: keyFn(x) })).sort((a, b) => cmp(a.k, b.k) || a.i - b.i).map(p => p.x);
}

const firstOrNull = l => (l !== null && l.length > 0 ? l[0] : null);
const elementAt = (l, i) => (l !== null && i < l.length ? l[i] : null);

// WeightedOptions: {key: weight} -> pairs (number, weight) by ascending key, weight 0 dropped
function weights(rs, table, map, where) {
	const l = [];
	const m = Y.map(map);
	if (m === null) return l;
	const ps = [...m].map(([k, v]) => ({ k: Y.str(k), v: Y.int(v) })).filter(p => p.v > 0);
	for (const p of stableOrderBy(ps, p => p.k, ordinal)) {
		l.push(rs.ref(table, p.k, where));
		l.push(p.v);
	}
	return l;
}

// {month: {key: weight}} -> [month, n, pairs] ...; skipEmpty — like RuleAlienMission (keeps no empty ones)
function monthWeights(rs, table, map, where, skipEmpty) {
	const l = [];
	const m = Y.map(map);
	if (m === null) return l;
	for (const [k, v] of stableOrderBy([...m], kv => Y.int(kv[0]))) {
		const w = weights(rs, table, v, where);
		if (skipEmpty && w.length === 0) continue;
		l.push(Y.int(k), Math.trunc(w.length / 2), ...w);
	}
	return l;
}

// Mission waves: ufo — a UFO, or #4000 + deployment (mission site at once), or -1 ("dummy")
function waves(rs, ws, where) {
	const l = [];
	for (const w of Y.list(ws) || []) {
		const ufo = Y.str(Y.get(w, 'ufo'));
		const u = rs.find('ufos', ufo), d = rs.find('alienDeployments', ufo);
		l.push(u >= 0 ? u : d >= 0 ? DEPLOYMENT_FLAG + d : -1);
		l.push(Y.int(Y.get(w, 'count'), 1));
		const tr = rs.ref('ufoTrajectories', Y.get(w, 'trajectory'), where);
		l.push(tr === NONE ? -1 : tr);
		l.push(Y.int(Y.get(w, 'timer')));
		l.push(Y.bool(Y.get(w, 'objective')) ? 1 : 0);
	}
	return l;
}

function varIndex(rs, name) {
	if (name === null || name.length === 0) return -1;
	const names = [...new Set(rs.entries.get('missionScripts').map(kv => Y.str(Y.get(kv[1], 'varName'))).filter(s => s !== null && s.length > 0))].sort(ordinal);
	if (names.length > NVARS) rs.warnings.push(`missionScripts: ${names.length} varName > NVARS (2, state.h)`);
	return names.indexOf(name);
}

// Mod::loadAll: siteType — objective of the first (by name) mission of missionWeights == OBJECTIVE_SITE
function scriptSiteType(rs, e) {
	const names = [];
	for (const [, v] of Y.map(Y.get(e, 'missionWeights')) || new Map())
		for (const [wk] of Y.map(v) || new Map()) names.push(Y.str(wk));
	if (names.length === 0) return false;
	const min = names.slice().sort(ordinal)[0];
	const i = rs.find('alienMissions', min);
	return i >= 0 && Y.int(Y.get(rs.entries.get('alienMissions')[i][1], 'objective')) === OBJECTIVE_SITE;
}

// missionZones areas of all regions back to back; zone starts -> cache "zoneStarts" for regions.zones
function zoneAreas(rs) {
	const list = [];
	const starts = new Map();
	for (const [regKey, reg] of rs.entries.get('regions')) {
		const st = [];
		for (const zone of Y.list(Y.get(reg, 'missionZones')) || []) {
			st.push(list.length);
			for (const a of Y.list(zone) || []) {
				const v = Y.list(a);
				if (v === null || v.length < 4) continue;
				const swap = Y.num(v[2]) > Y.num(v[3]);   // MissionArea: latMin > latMax — swap
				const d = new Map([
					['lonMin', v[0]], ['lonMax', v[1]],
					['latMin', swap ? v[3] : v[2]], ['latMax', swap ? v[2] : v[3]],
					['texture', v.length >= 5 ? v[4] : '0'],
					['name', v.length >= 6 ? v[5] : null],
				]);
				list.push([`${regKey}#${list.length}`, d]);
			}
		}
		st.push(list.length);
		starts.set(regKey, st);
	}
	rs.cache.set('zoneStarts', starts);
	return list;
}

function globeTextures(rs) {
	const l = [];
	const g = rs.sections.has('globe') ? rs.sections.get('globe') : null;
	for (const t of Y.list(Y.get(g, 'textures')) || []) {
		const id = Y.str(Y.get(t, 'id'));
		if (id !== null) l.push([id, t]);
	}
	return l;
}

// invs.slots: cells of the section grid — sizes and the mask of used cells (bit y * 4 + x)
function slotCells(e) {
	const l = Y.list(Y.get(e, 'slots'));
	if (l === null) return [];
	return l.map(c => Y.list(c)).filter(p => p !== null && p.length >= 2);
}

function slotSize(e, axis) {
	let m = -1;
	for (const p of slotCells(e)) m = Math.max(m, parseInt(Y.str(p[axis]), 10));
	return String(m + 1);
}

function slotMask(e) {
	let mask = 0;
	for (const p of slotCells(e)) {
		const x = parseInt(Y.str(p[0]), 10), y = parseInt(Y.str(p[1]), 10);
		if (x < SLOT_GRID && y < SLOT_GRID) mask |= 1 << (y * SLOT_GRID + x);
	}
	return String(mask);
}

// ArticleStateArmor: doll spriteInventory + "M0.SPK", otherwise + ".SPK" (whatever the packs have)
function armorImage(rs, id, type) {
	const ARTICLE_ARMOR = 5;
	if (type !== ARTICLE_ARMOR || !rs.index.get('armors').has(id)) return null;
	const inv = Y.str(Y.get(rs.entries.get('armors')[rs.index.get('armors').get(id)][1], 'spriteInv'));
	if (inv === null || inv.length === 0) return null;
	for (const n of [inv + 'M0.SPK', inv + '.SPK', inv])
		if (rs.resFind(n) >= 0) return n;
	return null;
}

const rectList = r => (r === null ? null : [Y.get(r, 'x'), Y.get(r, 'y'), Y.get(r, 'width'), Y.get(r, 'height')]);

// Article id = rule key: craft, craft weapon, unit, item, armour, facility, UFO
const ARTICLE_TABLES = new Map([
	[1, 'crafts'], [11, 'crafts'], [2, 'craftWeapons'], [12, 'craftWeapons'], [3, 'units'], [13, 'units'],
	[4, 'items'], [14, 'items'], [5, 'armors'], [15, 'armors'], [6, 'facilities'], [16, 'facilities'], [9, 'ufos'], [17, 'ufos'],
]);
function articleRule(rs, id, type) {
	const table = ARTICLE_TABLES.get(type);
	if (table === undefined) return NONE;
	const idx = rs.index.get(table);
	return idx.has(id) ? idx.get(id) : NONE;
}

// Global values and the starting base (RES_RULE_VARS resource):
// u8 sec, min, hour, weekday, day, month; u16 year;
// u32 initialFunding (thousands), u32 costEngineer, u32 costScientist, u16 timePersonnel;
// u16 alienFuel (item), u16 alienFuelAmount; u8 difficultyCoefficient[5];
// i32 defeatScore, i32 defeatFunds (difficulty.rul; defeat, 14_todo §3.13);
// starting base: u16 scientists, u16 engineers, u16 randomSoldiers;
// u8 nFacilities, {u16 facility, u8 x, u8 y} x n;
// u8 nCrafts, { u16 craft, u16 id, u16 fuel, u16 damage,
//   u8 nWeapons, {u16 craftWeapon, u16 ammo} x n,
//   u8 nItems, {u16 item, u16 qty} x n, u8 nVehicles, {u16 item, i16 ammo} x n } x n;
// u16 nItems, {u16 item, u16 count} x n.
function vars(s, rs) {
	const o = [];
	// C# (byte)/(int)/(long) casts of a double truncate toward zero
	const U8 = v => o.push(Math.trunc(Math.max(0, Math.min(255, v))) & 0xFF);
	const U16 = v => { const x = Math.trunc(Math.max(0, Math.min(0xFFFF, v))); o.push(x & 0xFF, (x >> 8) & 0xFF); };
	const U32 = v => o.push(...leBytes(Math.trunc(Math.max(0, v)), 4));
	const I32 = v => o.push(...leBytes(Math.trunc(v), 4));
	const G = k => (s.has(k) ? s.get(k) : null);
	const st = G('startingTime');
	U8(Y.num(Y.get(st, 'second'))); U8(Y.num(Y.get(st, 'minute'), 0)); U8(Y.num(Y.get(st, 'hour'), 12));
	U8(Y.num(Y.get(st, 'weekday'), 6)); U8(Y.num(Y.get(st, 'day'), 1)); U8(Y.num(Y.get(st, 'month'), 1)); U16(Y.num(Y.get(st, 'year'), 1999));
	U32(Y.num(G('initialFunding'))); U32(Y.num(G('costEngineer'))); U32(Y.num(G('costScientist'))); U16(Y.num(G('timePersonnel')));
	const fuel = Y.list(G('alienFuel'));
	U16(fuel !== null ? rs.ref('items', fuel[0], 'alienFuel') : NONE); U16(fuel !== null && fuel.length > 1 ? Y.num(fuel[1]) : 0);
	const dc = Y.list(G('difficultyCoefficient'));
	for (let i = 0; i < DIFFICULTY_LEVELS; i++) U8(dc !== null && i < dc.length ? Y.num(dc[i]) : i);
	I32(Y.num(G('defeatScore'))); I32(Y.num(G('defeatFunds')));
	const sb = G('startingBase');
	U16(Y.num(Y.get(sb, 'scientists'))); U16(Y.num(Y.get(sb, 'engineers')));
	const rsol = Y.get(sb, 'randomSoldiers');
	U16(Y.map(rsol) !== null ? [...Y.map(rsol).values()].reduce((a, v) => a + Y.num(v), 0) : Y.num(rsol));
	const fac = Y.list(Y.get(sb, 'facilities')) || [];
	U8(fac.length);
	for (const f of fac) { U16(rs.ref('facilities', Y.get(f, 'type'), 'startingBase.facilities')); U8(Y.num(Y.get(f, 'x'))); U8(Y.num(Y.get(f, 'y'))); }
	const cr = Y.list(Y.get(sb, 'crafts')) || [];
	U8(cr.length);
	for (const c of cr) {
		U16(rs.ref('crafts', Y.get(c, 'type'), 'startingBase.crafts'));
		U16(Y.num(Y.get(c, 'id'), 1)); U16(Y.num(Y.get(c, 'fuel'))); U16(Y.num(Y.get(c, 'damage')));
		const w = Y.list(Y.get(c, 'weapons')) || [];
		U8(w.length);
		for (const x of w) { U16(rs.ref('craftWeapons', Y.get(x, 'type'), 'startingBase.crafts.weapons')); U16(Y.num(Y.get(x, 'ammo'))); }
		const it = Y.map(Y.get(c, 'items')) || new Map();
		U8(it.size);
		for (const [k, v] of it) { U16(rs.ref('items', k, 'startingBase.crafts.items')); U16(Y.num(v)); }
		const ve = Y.list(Y.get(c, 'vehicles')) || [];
		U8(ve.length);
		for (const x of ve) { U16(rs.ref('items', Y.get(x, 'type'), 'startingBase.crafts.vehicles')); const a = Y.toInt(Y.num(Y.get(x, 'ammo'))); o.push(a & 0xFF, (a >> 8) & 0xFF); }
	}
	const items = Y.map(Y.get(sb, 'items')) || new Map();
	U16(items.size);
	for (const [k, v] of items) { U16(rs.ref('items', k, 'startingBase.items')); U16(Y.num(v)); }
	return Buffer.from(o);
}

module.exports = { RES_BASE, tables, vars };
