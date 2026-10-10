/* Kind mapping: JSON kind strings and syslog short names stay in sync with
 * the spec's event table; downstream PRs consume these names. */
#include "test_harness.h"

#include "../src/event.h"

#include <string.h>
#include <sys/prctl.h>

int main(void)
{
	/* the kinds the core can produce today */
	CHECK(strcmp(vig_kind_json(VIG_OP_EXEC), "process.exec") == 0);
	CHECK(strcmp(vig_kind_json(VIG_OP_HEALTH), "monitor.health") == 0);
	/* the kinds the hook/rule PRs will land */
	CHECK(strcmp(vig_kind_json(VIG_OP_FORK), "process.fork") == 0);
	CHECK(strcmp(vig_kind_json(VIG_OP_FILE_MUT), "file") == 0);
	CHECK(strcmp(vig_kind_json(VIG_OP_NET_CONN), "network.connection") == 0);
	CHECK(strcmp(vig_kind_json(VIG_OP_NET_LISTEN), "network.listen") == 0);
	CHECK(strcmp(vig_kind_json(VIG_OP_PRIV), "privilege.change") == 0);
	CHECK(strcmp(vig_kind_json(VIG_OP_MODULE), "kernel.module") == 0);

	/* syslog short names: exec, health, fork... */
	CHECK(strcmp(vig_kind_short(VIG_OP_EXEC), "exec") == 0);
	CHECK(strcmp(vig_kind_short(VIG_OP_FORK), "fork") == 0);
	CHECK(strcmp(vig_kind_short(VIG_OP_HEALTH), "health") == 0);

	/* unknown kinds map to nothing — never guessed */
	CHECK(vig_kind_json((enum vig_kind)999) == NULL);
	CHECK(vig_kind_short((enum vig_kind)999) == NULL);

	/* the record layout the BPF object writes must match the daemon's
	 * struct exactly (padding included) */
	CHECK(sizeof(struct vig_event) == 8 + 4 + 4 + 4 + 4 + 4 + 4 + 8 + 16 + 192);
	CHECK(sizeof(((struct vig_event *)0)->comm) == 16);

	char name[16];

	CHECK(prctl(PR_GET_NAME, name, 0, 0, 0) == 0); /* sanity: harness runs */

	TEST_END();
}
