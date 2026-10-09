# Host-runnable tests: pipeline (reorder window), syslog grammar, index
# rotation, event contract, record/replay fixtures. No kernel, no BPF load —
# those checks run on Debian VMs (see the PR's VM-pending list).
cmake_minimum_required(VERSION 3.18)
project(vigil-kernel-monitor-tests C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

add_library(vigil_core STATIC
	src/event.c
	src/index.c
	src/pipeline.c
	src/syslog_emit.c
	src/util.c)
target_include_directories(vigil_core PUBLIC src)
target_compile_options(vigil_core PRIVATE -Wall -Wextra)

enable_testing()

foreach(t pipeline syslog index event replay)
	add_executable(${t}_test tests/${t}_test.c)
	target_link_libraries(${t}_test PRIVATE vigil_core)
	target_compile_definitions(${t}_test PRIVATE
		FIXTURES_DIR="${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures")
	target_compile_options(${t}_test PRIVATE -Wall -Wextra)
	add_test(NAME ${t} COMMAND ${t}_test)
endforeach()
