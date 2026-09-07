#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/wait.h>

static int denied_probes = 0;
static int core_dumps = 0;

static pid_t observe_waitpid(pid_t pid, int *status, int options) {
  const pid_t result = waitpid(pid, status, options);
  if (result > 0 && WIFSIGNALED(*status) && WTERMSIG(*status) == SIGSYS) {
    denied_probes++;
    if (WCOREDUMP(*status)) core_dumps++;
  }
  return result;
}

// Observe the real probe statuses and require non-dumpability before installing
// each real filter, independently of the host's core_pattern or core limits.
#define waitpid observe_waitpid
#define prctl(option, ...) \
  (((option) == PR_SET_SECCOMP && prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) != 0) \
    ? (errno = EPERM, -1) : prctl((option), __VA_ARGS__))
#define main runtime_guardian_main
#include "../../native/runtime-process-guardian/linux.c"
#undef main
#undef prctl
#undef waitpid

int main(int argc, char **argv) {
  if (prctl(PR_SET_DUMPABLE, 1)) return 80;
  const int result = runtime_guardian_main(argc, argv);
  if (result != 0) return result;
  const int parent_dumpable = prctl(PR_GET_DUMPABLE, 0, 0, 0, 0);
  printf("{\"deniedProbes\":%d,\"coreDumps\":%d,\"parentDumpable\":%d}\n",
    denied_probes, core_dumps, parent_dumpable);
  return 0;
}
