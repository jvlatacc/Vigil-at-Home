#include "event.h"

const char *vig_kind_short(uint32_t kind)
{
	switch (kind) {
	case VIG_OP_EXEC: return "exec";
	case VIG_OP_FORK: return "fork";
	case VIG_OP_FILE_MUT: return "file";
	case VIG_OP_NET_CONN: return "net-conn";
	case VIG_OP_NET_LISTEN: return "net-listen";
	case VIG_OP_PRIV: return "priv";
	case VIG_OP_MODULE: return "module";
	case VIG_OP_HEALTH: return "health";
	/* an unknown kind maps to nothing — never guessed; the index line
	 * fails closed instead of emitting a fabricated record */
	default: return NULL;
	}
}

const char *vig_kind_json(uint32_t kind)
{
	switch (kind) {
	case VIG_OP_EXEC: return "process.exec";
	case VIG_OP_FORK: return "process.fork"; /* reserved; never emitted */
	case VIG_OP_FILE_MUT: return "file";
	case VIG_OP_NET_CONN: return "network.connection";
	case VIG_OP_NET_LISTEN: return "network.listen";
	case VIG_OP_PRIV: return "privilege.change";
	case VIG_OP_MODULE: return "kernel.module";
	case VIG_OP_HEALTH: return "monitor.health";
	default: return NULL;
	}
}
