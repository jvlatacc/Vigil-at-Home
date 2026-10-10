# Vigil kernel monitor — builds the CO-RE eBPF object and the userspace daemon.
#
# vmlinux.h is generated from the running kernel's BTF (CO-RE relocation needs
# nothing else). The CI workflow additionally compiles the object against the
# Debian 12 (6.1) and Debian 13 (6.12) kernel BTFs; see scripts/gen_vmlinux.sh.

CC      ?= cc
CLANG   ?= clang
BPFTOOL ?= $(shell command -v bpftool 2>/dev/null || echo /usr/sbin/bpftool)

BPF_DIR := bpf
SRC_DIR := src
BUILD   := build

ARCH ?= $(shell uname -m | sed 's/x86_64/x86/')

CFLAGS  ?= -O2 -g -Wall -Wextra -std=c11 -D_GNU_SOURCE
BPF_CFLAGS ?= -O2 -g -Wall -target bpf -D__TARGET_ARCH_$(ARCH) -I$(SRC_DIR)

LIBS := -lbpf -lelf -lz

DAEMON_SRCS := $(SRC_DIR)/daemon.c $(SRC_DIR)/event.c $(SRC_DIR)/index.c \
	       $(SRC_DIR)/json.c $(SRC_DIR)/pipeline.c $(SRC_DIR)/rules.c \
	       $(SRC_DIR)/syslog_emit.c $(SRC_DIR)/util.c \
	       $(SRC_DIR)/feature_probe.c $(SRC_DIR)/health.c $(SRC_DIR)/attach.c
DAEMON_OBJS := $(patsubst $(SRC_DIR)/%.c,$(BUILD)/%.o,$(DAEMON_SRCS))

TARGET := $(BUILD)/vigil-kernel-monitor
BPF_OBJ := $(BPF_DIR)/vigil.bpf.o
VMLINUX := $(SRC_DIR)/vmlinux.h
SKEL    := $(SRC_DIR)/vigil.skel.h

.PHONY: all clean test

all: $(TARGET)

$(TARGET): $(DAEMON_OBJS)
	$(CC) $(CFLAGS) -o $@ $^ $(LIBS)

$(BUILD)/%.o: $(SRC_DIR)/%.c $(SKEL) $(VMLINUX) | $(BUILD)
	$(CC) $(CFLAGS) -I$(SRC_DIR) -c $< -o $@

# The BPF object needs vmlinux.h; the skeleton comes back from its BTF.
# payload.h is the byte contract shared with src/index.c — keep the
# dependency so contract edits rebuild the object.
$(BPF_OBJ): $(BPF_DIR)/vigil.bpf.c $(SRC_DIR)/payload.h $(VMLINUX) | $(BUILD)
	$(CLANG) $(BPF_CFLAGS) -c $< -o $@

$(SKEL): $(BPF_OBJ)
	$(BPFTOOL) gen skeleton $(BPF_OBJ) > $@

$(VMLINUX): $(wildcard /sys/kernel/btf/vmlinux) scripts/gen_vmlinux.sh
	./scripts/gen_vmlinux.sh $@

$(BUILD):
	mkdir -p $(BUILD)

test: $(TARGET)
	cmake -S . -B $(BUILD)/test -DCMAKE_BUILD_TYPE=Debug
	cmake --build $(BUILD)/test -j
	cd $(BUILD)/test && ctest --output-on-failure

clean:
	rm -rf $(BUILD) $(SKEL) $(BPF_OBJ)
