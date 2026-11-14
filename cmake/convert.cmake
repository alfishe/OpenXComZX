# Game data conversion step of CMakeLists.txt (cmake -P): runs OxzConv only when the packs
# are missing or older than the converter, so packs made earlier (by build.js or copied
# from another machine) are kept as long as the converter is the same.
#   -DCONV_RUN=<converter command> -DCONV=<converter stamp, touched when its sources change>
#   -DGAME_DIR=<game folder> -DSD_OUT=<tmp/sd> -DRULES=<.../RULES.PAK> -DSTAMP=<step stamp>
if(NOT EXISTS "${RULES}" OR "${CONV}" IS_NEWER_THAN "${RULES}")
    if(NOT EXISTS "${GAME_DIR}")
        message(FATAL_ERROR "no game folder ${GAME_DIR} (OXZ_GAME_DIR / build.js -GameDir)")
    endif()
    execute_process(COMMAND ${CONV_RUN} --game ${GAME_DIR} --out ${SD_OUT} RESULT_VARIABLE rc)
    if(NOT rc EQUAL 0)
        message(FATAL_ERROR "OxzConv failed (${rc})")
    endif()
endif()
file(TOUCH "${STAMP}")
