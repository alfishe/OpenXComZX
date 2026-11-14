# OpenXComZX build: SDCC -> Intel HEX -> map check -> SPG (+ data packs) + labels.
# Memory layout: src/inc/memmap.h, project_docs/08_ui_port_plan.md §4.
#
# Usually driven by tools/build.js (same commands as before: -Game, -GameDir, -NoCard);
# directly:
#   cmake -S . -B tmp/build -G Ninja -DOXZ_GAME=UFO -DOXZ_GAME_DIR=<game folder>
#   cmake --build tmp/build
# The build directory must be tmp/build: run.js, runtests.js, codesize.js and the docs
# expect tmp/build/oxz.spg, oxz.labels, *.rel there.
#
# Every source is its own build step: only changed files (and the ones whose headers
# changed - sdcc -MMD depfiles) are recompiled, independent ones in parallel.
cmake_minimum_required(VERSION 3.20)   # DEPFILE for Ninja and Makefile generators
project(OpenXComZX NONE)

set(ROOT ${CMAKE_CURRENT_SOURCE_DIR})
set(SRC ${ROOT}/src)
set(OUT ${CMAKE_CURRENT_BINARY_DIR})
set(STAMPS ${OUT}/stamps)
set(GEN ${OUT}/gen)
set(TOOL_TMP ${OUT}/tooltmp)           # TMPDIR/TEMP of sdcc: temporary files stay in the project
file(MAKE_DIRECTORY ${STAMPS} ${GEN} ${TOOL_TMP})
if(NOT OUT STREQUAL "${ROOT}/tmp/build")
    message(WARNING "build directory is ${OUT}; the project scripts expect ${ROOT}/tmp/build")
endif()

set(OXZ_GAME "TFTD" CACHE STRING "Game data to build with: TFTD or UFO")
set_property(CACHE OXZ_GAME PROPERTY STRINGS TFTD UFO)
set(OXZ_GAME_DIR "" CACHE PATH "Original game folder (with GEODATA); empty - the default under Steam/")
option(OXZ_CARD "Build the SD card (distr/ + oxz_card.img) when the converted data changes" ON)
if(NOT OXZ_GAME MATCHES "^(TFTD|UFO)$")
    message(FATAL_ERROR "OXZ_GAME must be TFTD or UFO, not '${OXZ_GAME}'")
endif()

# ---------------------------------------------------------------------------- tools
# SDCC must be exactly 4.5.0: the code works around its code generation bugs (CLAUDE.md,
# tools/checkasm.js). A local build (tools/setup_unix.sh) goes before PATH.
set(SDCC_LOCAL ${ROOT}/tmp/toolchain/sdcc-4.5.0/bin)
find_program(OXZ_SDCC sdcc HINTS ${SDCC_LOCAL} REQUIRED)
find_program(OXZ_SDAS sdasz80 HINTS ${SDCC_LOCAL} REQUIRED)
find_program(OXZ_NODE node REQUIRED)
execute_process(COMMAND ${OXZ_SDCC} --version OUTPUT_VARIABLE SDCC_VERSION_TEXT ERROR_QUIET)
if(NOT SDCC_VERSION_TEXT MATCHES " 4\\.5\\.0 ")
    message(WARNING "SDCC is not 4.5.0 (${OXZ_SDCC}): the workarounds are verified on 4.5.0 only")
endif()

# Converter OxzConv: Node.js (tools/oxzconv), no build step.
set(CONV_RUN ${OXZ_NODE} ${ROOT}/tools/oxzconv/oxzconv.js)

# --------------------------------------------------------------------- memory layout
set(KERNEL_PAGE 0x04)
set(DATA_PAGE   0x05)
set(CODE_LOC 0x0100)
set(CODE_END 0x2000)        # общий код в Win0 (занято до #1CC7, запас — десятки байт)
set(DATA_LOC 0x4000)
set(DATA_END 0x7C00)        # данные в Win1
set(DMABUF_LOC 0x7C00)
set(DMABUF_END 0x7FE0)      # буферы DMA (чётная база); #7FE0-#7FF0 — заглушка входа
set(ENTRY 0x7FE0)
set(STACK_TOP 0x3EF0)       # впритык под векторы IM2 (#3EFB)
# Кольцо музыки и переменные плеера в Win0 (20 §4): прерывание не переключает окна, и
# читать кольцо ему неоткуда. Ниже #3010 — стек ядра: в геоскейпе он проседает на два
# килобайта, до кольца остаётся меньше полутора, поэтому в прерывании стоит сторож
# (crt0.s, STACK_GUARD). Вынести кольцо в свою страницу — 14 §todo.
set(MUSIC_LOC 0x2000)
set(MUSIC_END 0x3010)
set(RES_PAGE 0x50)          # пакеты данных (memmap.h RES_PAGE..RES_LAST)
set(RES_LAST 0xAF)
set(BANK_WINDOW 0x8000)     # банк n: виртуальные адреса n*#10000 + #8000..#BFFF (Win2)
set(BANK_SIZE   0x4000)
set(BANK_STRIDE 0x10000)
set(NO_BANK_PAGE 0x02)      # номер банка без файлов: страница Win2 начала SPG

# Общий код (Win0): ассемблер ядра и C-модули без банка. crt0 — первым: порядок областей;
# kernel/win0 — код окна 0; dmabuf (буферы DMA в Win1) и sd (код в банке 12) — ассемблер
# ядра вне Win0.
set(ASM_COMMON
    kernel/win0/crt0 kernel/win0/bank kernel/dmabuf kernel/win0/glyph kernel/win0/mul32
    kernel/win0/div32 kernel/sd kernel/win0/pages kernel/win0/far kernel/win0/res
    kernel/win0/dbg kernel/win0/input kernel/win0/music_s kernel/win0/scrutil kernel/win0/text)
set(C_COMMON)               # Win0 — только ассемблер (14_todo.md §1.3)

# Банки кода (Win2): oxz_bank(<номер> PAGE <страница> [RAM <адрес>] [TAB <адрес>] FILES ...)
# Страницы: резидентные #30-#3F, оверлей #40-#4F (08 §4.2, §4.3a). Файл с .s — ассемблер
# банка (область .area _BANKn в самом файле), иначе C с --codeseg/--constseg BANKn.
# RAM — с этого адреса хвост страницы занят рабочими таблицами банка, код — до него;
# TAB — выровненная таблица _GTAB с этого адреса до конца банка.
set(BANK_NUMBERS)
function(oxz_bank n)
    cmake_parse_arguments(B "" "PAGE;RAM;TAB" "FILES" ${ARGN})
    set(BANK_NUMBERS ${BANK_NUMBERS} ${n} PARENT_SCOPE)
    set(BANK${n}_PAGE ${B_PAGE} PARENT_SCOPE)
    set(BANK${n}_RAM "${B_RAM}" PARENT_SCOPE)
    set(BANK${n}_TAB "${B_TAB}" PARENT_SCOPE)
    set(BANK${n}_FILES ${B_FILES} PARENT_SCOPE)
endfunction()

oxz_bank(1  PAGE 0x30 FILES common/ui common/screens)   # ядро интерфейса + диспетчер экранов
oxz_bank(2  PAGE 0x31 FILES common/scr_menu common/names geoscape/scr_end geoscape/earth/globe_ui geoscape/earth/globe_ui_tab)   # меню; имена объектов для всех окон; концовки; точки глобуса
oxz_bank(3  PAGE 0x32 FILES geoscape/earth/scr_geo)
oxz_bank(4  PAGE 0x33 FILES geoscape/earth/scr_geo2 geoscape/earth/scr_graph)
oxz_bank(5  PAGE 0x34 FILES geoscape/base/scr_base)
oxz_bank(6  PAGE 0x35 FILES geoscape/base/scr_base2)
oxz_bank(7  PAGE 0x36 FILES geoscape/save geoscape/newgame geoscape/base/econ kernel/bios)   # bios — только для save.c
oxz_bank(8  PAGE 0x37 FILES geoscape/gtime geoscape/base/lab)
oxz_bank(9  PAGE 0x38 FILES geoscape/base/scr_lab)
oxz_bank(10 PAGE 0x39 FILES geoscape/base/scr_craft)
oxz_bank(11 PAGE 0x3A RAM 0xBF00 FILES kernel/gfx kernel/cursor kernel/boot)   # графика, опрос ввода, запуск; с #BF00 — фон под всплывающими окнами (gfx.c)
oxz_bank(12 PAGE 0x3B RAM 0xBB00 FILES kernel/fat kernel/sdres kernel/music)   # музыка: состояние плеера с #BF00, каталог и кэш SD (sdres.c) — с #BB00
oxz_bank(13 PAGE 0x3C FILES common/scr_ufop)
oxz_bank(14 PAGE 0x3E RAM 0xB000 FILES test/bank_a test/mathtest kernel/sddiag)   # служебный: самотест джампера, диагностика SD (с #B000 — её результаты)
oxz_bank(15 PAGE 0x3F FILES test/bank_b)
oxz_bank(16 PAGE 0x3D FILES geoscape/month)   # конец месяца
oxz_bank(17 PAGE 0x40 FILES geoscape/earth/world geoscape/earth/geo)   # ГСЧ, регионы, сфера, маска суши
oxz_bank(18 PAGE 0x41 FILES geoscape/earth/alien)   # стратегия и миссии пришельцев
oxz_bank(19 PAGE 0x42 FILES geoscape/earth/ufo)     # НЛО, обнаружение, места миссий, базы пришельцев
oxz_bank(20 PAGE 0x43 FILES geoscape/earth/craft)   # полёты кораблей X-COM
oxz_bank(21 PAGE 0x44 FILES geoscape/earth/scr_fly)   # окна полёта: перехват, корабль, цель
oxz_bank(22 PAGE 0x45 FILES geoscape/earth/dogfight)   # воздушный бой: логика
oxz_bank(23 PAGE 0x46 FILES geoscape/earth/scr_dogf)   # воздушный бой: окна
oxz_bank(24 PAGE 0x47 TAB 0xBC00 FILES geoscape/earth/globe geoscape/earth/globe_s geoscape/earth/globe_tab geoscape/earth/globe_sq)   # глобус (globe.md): globe_s.s — асм, globe_sq.s — таблица _GTAB с #BC00
oxz_bank(25 PAGE 0x48 RAM 0xB800 FILES geoscape/earth/globe_sh geoscape/earth/globe_sh_s geoscape/earth/globe_view geoscape/earth/globe_sh_tab)   # глобус, банк 25 — ассемблер: тень (globe_sh.s — кадр, globe_sh_s.s — блоки и строки, globe_sh_tab.s — таблицы), предрасчитанные виды (globe_view.s); с #B800 — рабочие таблицы тени
oxz_bank(26 PAGE 0x49 RAM 0xA800 FILES geoscape/earth/globe_det geoscape/earth/globe_det_s)   # детали глобуса: линии, подписи, города (globe_det.c; точки и отрезки — globe_det_s.s); с #A800 — рабочая память
oxz_bank(27 PAGE 0x4A RAM 0xB000 FILES geoscape/base/scr_inv)   # инвентарь бойца (экипировка перед вылетом); с #B000 — точки под несомым предметом
oxz_bank(28 PAGE 0x4B RAM 0xB000 FILES battlescape/scr_battle)   # наземный бой: отрисовка карты (этап Б1)
oxz_bank(29 PAGE 0x4C RAM 0xB000 FILES battlescape/mapgen)   # генератор миссии: карта из блоков по mapScript (16 §3)
oxz_bank(30 PAGE 0x4D FILES battlescape/pathfind battlescape/units battlescape/doors battlescape/loader)   # поиск пути (16 §5.4), бойцы миссии, клетки карты (двери, цена прохода) и загрузка графики миссии

# Пакеты данных игры, вшитые в SPG (выход OxzConv, tmp/sd/OXZ/<игра>). MCD — наборы частей
# карт, террейны и mapScripts для генератора миссий (16 §3). Остальные пакеты игра читает
# с SD-карты (tools/dist.js).
set(PACKS PAL LANG RULES GEO MCD)

# ------------------------------------------------------------ converter and game data
file(GLOB_RECURSE CONV_SRC CONFIGURE_DEPENDS
    ${ROOT}/tools/oxzconv/*.js ${ROOT}/tools/oxzconv/data/*.txt ${ROOT}/tools/oxzconv/data/*.json)
# The stamp is the converter's "version": newer than RULES.PAK means the data is stale.
set(CONV_STAMP ${STAMPS}/oxzconv.stamp)
add_custom_command(OUTPUT ${CONV_STAMP}
    COMMAND ${CMAKE_COMMAND} -E touch ${CONV_STAMP}
    DEPENDS ${CONV_SRC}
    COMMENT "OxzConv: converter changed"
    VERBATIM)

if(OXZ_GAME_DIR)
    get_filename_component(GAME_DIR "${OXZ_GAME_DIR}" ABSOLUTE BASE_DIR ${ROOT})
elseif(OXZ_GAME STREQUAL "TFTD")
    set(GAME_DIR "${ROOT}/Steam/X-COM Terror from the Deep/TFD")
else()
    set(GAME_DIR "${ROOT}/Steam/XCom UFO Defense/XCOM")
endif()
set(SD_OUT ${ROOT}/tmp/sd)
set(DATA ${SD_OUT}/OXZ/${OXZ_GAME})
set(DATA_STAMP ${STAMPS}/data-${OXZ_GAME}.stamp)
set(PACK_FILES)
foreach(p IN LISTS PACKS)
    list(APPEND PACK_FILES ${DATA}/${p}.PAK)
endforeach()
# Converts the game when its packs are missing or older than the converter
# (cmake/convert.cmake): data from a previous build or another machine is kept.
add_custom_command(OUTPUT ${DATA_STAMP}
    BYPRODUCTS ${PACK_FILES}
    COMMAND ${CMAKE_COMMAND} "-DCONV_RUN=${CONV_RUN}" "-DCONV=${CONV_STAMP}"
            "-DGAME_DIR=${GAME_DIR}" "-DSD_OUT=${SD_OUT}" "-DRULES=${DATA}/RULES.PAK"
            "-DSTAMP=${DATA_STAMP}" -P ${ROOT}/cmake/convert.cmake
    DEPENDS ${CONV_STAMP} ${ROOT}/cmake/convert.cmake
    COMMENT "OxzConv: game data ${OXZ_GAME}"
    VERBATIM)

set(GEN_HEADERS ${GEN}/res_ids.h ${GEN}/str_ids.h ${GEN}/ui_ids.h ${GEN}/mus_ids.h ${GEN}/rules.h)
add_custom_command(OUTPUT ${GEN_HEADERS}
    COMMAND ${CONV_RUN} headers ${GEN}
    DEPENDS ${CONV_STAMP}
    COMMENT "OxzConv: registry headers"
    VERBATIM)

# Card: distr/ + oxz_card.img in the project root - the same card for the emulator and the
# hardware (23_distribution.md); dist.js -NoBuild lays it out when the data changes.
if(OXZ_CARD)
    add_custom_command(OUTPUT ${ROOT}/oxz_card.img
        COMMAND ${OXZ_NODE} ${ROOT}/tools/dist.js -NoBuild
        DEPENDS ${DATA_STAMP} ${ROOT}/tools/dist.js ${ROOT}/tools/fat32img.js
        WORKING_DIRECTORY ${ROOT}
        COMMENT "SD card: distr/ and oxz_card.img"
        VERBATIM)
    add_custom_target(card ALL DEPENDS ${ROOT}/oxz_card.img)
endif()

# ------------------------------------------------------------------- generated tables
# Таблица «банк -> страница» для set_bank (src/kernel/win0/bank.s)
list(SORT BANK_NUMBERS COMPARE NATURAL)
list(GET BANK_NUMBERS -1 MAX_BANK)
set(BANKS_ASM "\t.module banks\r\n\t.area _CODE\r\n_bank_page::\r\n\t.db ${NO_BANK_PAGE}\t; bank 0: Win2 page at SPG start\r\n")
foreach(n RANGE 1 ${MAX_BANK})
    if(DEFINED BANK${n}_PAGE)
        string(APPEND BANKS_ASM "\t.db ${BANK${n}_PAGE}\t; bank ${n}\r\n")
    else()
        string(APPEND BANKS_ASM "\t.db ${NO_BANK_PAGE}\t; bank ${n}\r\n")
    endif()
endforeach()
file(CONFIGURE OUTPUT ${OUT}/banks.s CONTENT "${BANKS_ASM}" @ONLY)   # rewritten only on change

# Раскладка пакетов по страницам и таблица pack_page для src/kernel/win0/res.s
add_custom_command(OUTPUT ${OUT}/packs.s ${OUT}/packs.data
    COMMAND ${OXZ_NODE} ${ROOT}/tools/mkpacks.js ${OUT}/packs.s ${OUT}/packs.data ${RES_PAGE} ${RES_LAST} ${PACK_FILES}
    DEPENDS ${DATA_STAMP} ${ROOT}/tools/mkpacks.js
    COMMENT "Data packs: page layout"
    VERBATIM)

# ------------------------------------------------------------------------ compiling
set(CFLAGS -mz80 --sdcccall 1 --opt-code-size --std-sdcc11
    --debug   # отладочные записи (.adb -> oxz.cdb): адреса и статических функций — для меток
              # отладчика и профилировщика эмулятора (tools/mklabels.js); код не меняется
    -I ${SRC}/inc -I ${SRC}/common -I ${GEN})
set(SDCCW ${OXZ_NODE} ${ROOT}/tools/sdccw.js)
set(RELS)
set(C_ASM)        # .asm of the C modules, for tools/checkasm.js
set(C_RELS)

# oxz_asm(<source .s> <out name>) / oxz_c(<source .c> <out name> [segment])
function(oxz_asm s name)
    set(rel ${OUT}/${name}.rel)
    add_custom_command(OUTPUT ${rel}
        BYPRODUCTS ${OUT}/${name}.lst ${OUT}/${name}.sym
        COMMAND ${SDCCW} --tmp ${TOOL_TMP} -- ${OXZ_SDAS} -plosgff -o ${rel} ${s}
        DEPENDS ${s} ${ROOT}/tools/sdccw.js
        COMMENT "sdasz80 ${name}.s"
        VERBATIM)
    set(RELS ${RELS} ${rel} PARENT_SCOPE)
endfunction()
function(oxz_c c name)
    set(rel ${OUT}/${name}.rel)
    set(seg)
    if(ARGC GREATER 2)
        set(seg --codeseg ${ARGV2} --constseg ${ARGV2})
    endif()
    add_custom_command(OUTPUT ${rel}
        BYPRODUCTS ${OUT}/${name}.asm ${OUT}/${name}.lst ${OUT}/${name}.sym ${OUT}/${name}.adb
        COMMAND ${SDCCW} --dep ${rel} ${OUT}/${name}.d --tmp ${TOOL_TMP} --
                ${OXZ_SDCC} ${CFLAGS} ${seg} -MMD -c ${c} -o ${rel}
        DEPENDS ${c} ${GEN_HEADERS} ${ROOT}/tools/sdccw.js
        DEPFILE ${OUT}/${name}.d
        COMMENT "sdcc ${name}.c"
        VERBATIM)
    set(RELS ${RELS} ${rel} PARENT_SCOPE)
    set(C_RELS ${C_RELS} ${rel} PARENT_SCOPE)
    set(C_ASM ${C_ASM} ${OUT}/${name}.asm PARENT_SCOPE)
endfunction()

# Link order = this order: Win0 assembler (crt0 first), tables, Win0 C, then the banks.
foreach(a IN LISTS ASM_COMMON)
    get_filename_component(name ${a} NAME)
    oxz_asm(${SRC}/${a}.s ${name})
endforeach()
oxz_asm(${OUT}/banks.s banks)
oxz_asm(${OUT}/packs.s packs)
foreach(c IN LISTS C_COMMON)
    get_filename_component(name ${c} NAME)
    oxz_c(${SRC}/${c}.c ${name})
endforeach()

# oxz_hex(<var> <expr>): 0x + upper-case hex digits, as the linker echoes them into oxz.map
function(oxz_hex var expr)
    math(EXPR v "${expr}" OUTPUT_FORMAT HEXADECIMAL)
    string(SUBSTRING ${v} 2 -1 digits)
    string(TOUPPER ${digits} digits)
    set(${var} 0x${digits} PARENT_SCOPE)
endfunction()
set(BANK_LINK)
set(BANK_CHECK)
set(BANK_MAP)
foreach(n IN LISTS BANK_NUMBERS)
    set(seg BANK${n})
    foreach(f IN LISTS BANK${n}_FILES)
        get_filename_component(name ${f} NAME)
        if(EXISTS ${SRC}/${f}.s)
            oxz_asm(${SRC}/${f}.s ${name})
        else()
            oxz_c(${SRC}/${f}.c ${name} ${seg})
        endif()
    endforeach()
    oxz_hex(base "${n} * ${BANK_STRIDE} + ${BANK_WINDOW}")
    oxz_hex(bank_end "${base} + ${BANK_SIZE}")
    # --codeseg BANKn даёт область _BANKn; TAB — выровненная таблица _GTAB в конце банка
    list(APPEND BANK_LINK -Wl-b_${seg}=${base})
    if(BANK${n}_TAB)
        oxz_hex(tab_at "${n} * ${BANK_STRIDE} + ${BANK${n}_TAB}")
        list(APPEND BANK_LINK -Wl-b_GTAB=${tab_at})
        list(APPEND BANK_CHECK _${seg}=${base}-${tab_at} _GTAB=${tab_at}-${bank_end})
    elseif(BANK${n}_RAM)
        oxz_hex(ram_at "${n} * ${BANK_STRIDE} + ${BANK${n}_RAM}")
        list(APPEND BANK_CHECK _${seg}=${base}-${ram_at})
    else()
        list(APPEND BANK_CHECK _${seg}=${base}-${bank_end})
    endif()
    list(APPEND BANK_MAP --bank ${n}:${BANK${n}_PAGE})
endforeach()

# Ошибка кодогенерации SDCC 4.5 (сравнение с памятью через sub) — tools/checkasm.js
set(CHECKASM_STAMP ${STAMPS}/checkasm.stamp)
add_custom_command(OUTPUT ${CHECKASM_STAMP}
    COMMAND ${OXZ_NODE} ${ROOT}/tools/checkasm.js ${C_ASM}
    COMMAND ${CMAKE_COMMAND} -E touch ${CHECKASM_STAMP}
    DEPENDS ${C_RELS} ${ROOT}/tools/checkasm.js
    COMMENT "checkasm: SDCC 4.5 compare-through-sub bug"
    VERBATIM)

# --------------------------------------------------------------------------- linking
set(IHX ${OUT}/oxz.ihx)
add_custom_command(OUTPUT ${IHX}
    BYPRODUCTS ${OUT}/oxz.map ${OUT}/oxz.noi ${OUT}/oxz.cdb ${OUT}/oxz.lk
    COMMAND ${SDCCW} --tmp ${TOOL_TMP} -- ${OXZ_SDCC} -mz80 --sdcccall 1 --no-std-crt0 --debug
            --code-loc ${CODE_LOC} --data-loc ${DATA_LOC}
            -Wl-b_DMABUF=${DMABUF_LOC} -Wl-b_MUSIC=${MUSIC_LOC} ${BANK_LINK} -o ${IHX} ${RELS}
    DEPENDS ${RELS} ${CHECKASM_STAMP}
    COMMENT "Link oxz.ihx"
    VERBATIM)

set(CHECKMAP_STAMP ${STAMPS}/checkmap.stamp)
add_custom_command(OUTPUT ${CHECKMAP_STAMP}
    COMMAND ${OXZ_NODE} ${ROOT}/tools/checkmap.js ${OUT}/oxz.map
            _CODE,_HOME,_INITIALIZER,_GSINIT,_GSFINAL=${CODE_LOC}-${CODE_END}
            _DATA,_INITIALIZED,_BSEG,_BSS,_HEAP,_KDATA=${DATA_LOC}-${DATA_END}
            _DMABUF=${DMABUF_LOC}-${DMABUF_END} _MUSIC=${MUSIC_LOC}-${MUSIC_END} ${BANK_CHECK}
    COMMAND ${CMAKE_COMMAND} -E touch ${CHECKMAP_STAMP}
    DEPENDS ${IHX} ${ROOT}/tools/checkmap.js
    COMMENT "checkmap: areas inside their windows"
    VERBATIM)

set(WINMAP --win 0:${KERNEL_PAGE} --win 1:${DATA_PAGE} ${BANK_MAP})
add_custom_command(OUTPUT ${OUT}/oxz.spg
    COMMAND ${OXZ_NODE} ${ROOT}/tools/mkspg.js ${IHX} ${OUT}/oxz.spg --pc ${ENTRY} --sp ${STACK_TOP}
            ${WINMAP} --data-list ${OUT}/packs.data
    DEPENDS ${IHX} ${CHECKMAP_STAMP} ${OUT}/packs.data ${DATA_STAMP} ${ROOT}/tools/mkspg.js
    COMMENT "SPG oxz.spg (${OXZ_GAME})"
    VERBATIM)
add_custom_command(OUTPUT ${OUT}/oxz.labels
    COMMAND ${OXZ_NODE} ${ROOT}/tools/mklabels.js ${OUT}/oxz.noi ${OUT}/oxz.labels --cdb ${OUT}/oxz.cdb ${WINMAP}
    DEPENDS ${IHX} ${ROOT}/tools/mklabels.js
    COMMENT "Labels oxz.labels"
    VERBATIM)
add_custom_target(oxz ALL DEPENDS ${OUT}/oxz.spg ${OUT}/oxz.labels)
