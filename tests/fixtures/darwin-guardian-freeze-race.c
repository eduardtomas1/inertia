#include <libproc.h>
#include <signal.h>
#include <stdint.h>
#include <sys/sysctl.h>
#include <sys/wait.h>

static int fixture_proc_pidinfo(int, int, uint64_t, void *, int);
static int fixture_sysctl(int *, u_int, void *, size_t *, void *, size_t);
static int fixture_kill(pid_t, int);
static pid_t fixture_waitpid(pid_t, int *, int);
#define proc_pidinfo fixture_proc_pidinfo
#define sysctl fixture_sysctl
#define kill fixture_kill
#define waitpid fixture_waitpid
#define main guardian_main
#include "../../native/runtime-process-guardian/darwin.c"
#undef main
#undef waitpid
#undef kill
#undef sysctl
#undef proc_pidinfo

static const char *scenario = NULL;
static pid_t fixture_child = 0;
static int exit_pipe = -1;
static int child_identity_reads = 0;
static int zombie_observed = 0;
static int zombie_libproc_bytes = -1;
static int stop_signals_delivered = 0;
static int non_child_wait_attempts = 0;

static int scenario_is(const char *value) {
  return strcmp(scenario, value) == 0;
}

static int fixture_proc_pidinfo(
  int pid, int flavor, uint64_t arg, void *buffer, int size
) {
  if (pid != fixture_child || flavor != PROC_PIDTBSDINFO) {
    return proc_pidinfo(pid, flavor, arg, buffer, size);
  }
  child_identity_reads += 1;
  if (child_identity_reads == 2 && (scenario_is("direct-exit")
    || scenario_is("direct-exit-with-survivor")
    || scenario_is("non-child-exit")
    || scenario_is("fork-tainted-exit"))) {
    // The first read belonged to the completed ownership census. Release the
    // real child at its subsequent exact signal probe and await real SZOMB;
    // both identity APIs below still execute against the unmodified kernel.
    if (write(exit_pipe, "x", 1) != 1) _exit(90);
    const struct timespec pause = { .tv_sec = 0, .tv_nsec = 1000000L };
    for (int poll = 0; poll < 1000; poll += 1) {
      if (process_status(fixture_child) == SZOMB) {
        zombie_observed = 1;
        break;
      }
      (void)nanosleep(&pause, NULL);
    }
    if (!zombie_observed) _exit(91);
    zombie_libproc_bytes = proc_pidinfo(pid, flavor, arg, buffer, size);
    return zombie_libproc_bytes;
  }
  if (child_identity_reads >= 2 && scenario_is("live-unreadable")) return 0;
  const int bytes = proc_pidinfo(pid, flavor, arg, buffer, size);
  if (child_identity_reads >= 2 && scenario_is("changed-birth")
    && bytes == (int)sizeof(struct proc_bsdinfo)) {
    ((struct proc_bsdinfo *)buffer)->pbi_start_tvsec += 1;
  }
  return bytes;
}

static int fixture_sysctl(
  int *query, u_int count, void *result, size_t *size, void *value, size_t value_size
) {
  if (scenario_is("live-unreadable") && child_identity_reads >= 2
    && count == 4 && query[0] == CTL_KERN && query[1] == KERN_PROC
    && query[2] == KERN_PROC_PID && query[3] == fixture_child) {
    errno = EIO;
    return -1;
  }
  return sysctl(query, count, result, size, value, value_size);
}

static int fixture_kill(pid_t pid, int signal_number) {
  if (pid == fixture_child && signal_number == SIGSTOP) {
    if (scenario_is("signal-refused")) {
      errno = EPERM;
      return -1;
    }
    stop_signals_delivered += 1;
  }
  return kill(pid, signal_number);
}

static pid_t fixture_waitpid(pid_t pid, int *status, int options) {
  if (pid == fixture_child && scenario_is("non-child-exit")) {
    non_child_wait_attempts += 1;
  }
  return waitpid(pid, status, options);
}

static void dispose_direct_child(pid_t pid) {
  if (pid <= 1) return;
  int status = 0;
  // A positive nonblocking wait reaps the fixture's child; zero preserves its
  // exclusive unreaped child PID for the bounded emergency teardown signals.
  if (waitpid(pid, &status, WNOHANG) == 0) {
    (void)kill(pid, SIGKILL);
    (void)kill(pid, SIGCONT);
    for (int poll = 0; poll < 1000; poll += 1) {
      if (waitpid(pid, &status, WNOHANG) != 0) return;
      const struct timespec pause = { .tv_sec = 0, .tv_nsec = 1000000L };
      (void)nanosleep(&pause, NULL);
    }
    _exit(92);
  }
}

static int run_fixture(void) {
  // The outer runner fork ensures setsid cannot fail because of inherited
  // process-group leadership. Only this isolated session enters the census.
  if (setsid() != getpid()) return 80;
  int gate[2];
  if (pipe(gate) != 0) return 81;
  pid_t survivor = 0;
  if (scenario_is("non-child-exit")) {
    int report[2];
    if (pipe(report) != 0) return 93;
    survivor = fork();
    if (survivor < 0) return 94;
    if (survivor == 0) {
      alarm(5);
      close(report[0]);
      close(gate[1]);
      const pid_t descendant = fork();
      if (descendant < 0) _exit(95);
      if (descendant == 0) {
        alarm(5);
        close(report[1]);
        char byte = 0;
        _exit(read(gate[0], &byte, 1) == 1 ? 0 : 83);
      }
      if (write(report[1], &descendant, sizeof(descendant))
        != sizeof(descendant)) _exit(96);
      close(report[1]);
      for (;;) pause();
    }
    close(report[1]);
    if (read(report[0], &fixture_child, sizeof(fixture_child))
      != sizeof(fixture_child)) return 97;
    close(report[0]);
  } else {
    fixture_child = fork();
    if (fixture_child < 0) return 82;
    if (fixture_child == 0) {
      alarm(5);
      close(gate[1]);
      char byte = 0;
      const int released = read(gate[0], &byte, 1) == 1;
      _exit(released ? 0 : 83);
    }
  }
  close(gate[0]);
  exit_pipe = gate[1];
  if (scenario_is("direct-exit-with-survivor")) {
    survivor = fork();
    if (survivor < 0) return 84;
    if (survivor == 0) {
      alarm(5);
      for (;;) pause();
    }
  }
  struct owned_tree_tracker tracker;
  if (!initialize_owned_tree_tracker(&tracker)) return 85;
  if (!arm_root_fork_observer(&tracker, fixture_child)) return 86;
  if (scenario_is("fork-tainted-exit")) tracker.fork_tainted = 1;
  const int cleaned = bounded_owned_tree_cleanup(
    getpid(), getpid(), &tracker, 0, 0, 0, NULL
  );
  int status = 0;
  errno = 0;
  const int survivor_reaped = survivor > 1
    && waitpid(survivor, &status, WNOHANG) < 0 && errno == ECHILD;
  const int non_child_zombie_retained = scenario_is("non-child-exit")
    && process_status(fixture_child) == SZOMB
    && waitpid(fixture_child, &status, WNOHANG) < 0 && errno == ECHILD;
  printf(
    "{\"cleaned\":%d,\"phase\":\"%s\",\"census\":\"%s\","
    "\"identityReads\":%d,\"zombieObserved\":%d,\"zombieLibprocBytes\":%d,"
    "\"stopSignalsDelivered\":%d,\"members\":%d,\"forkTainted\":%d,"
    "\"survivorReaped\":%d,\"nonChildZombieRetained\":%d,"
    "\"nonChildWaitAttempts\":%d}\n",
    cleaned, cleanup_failure_reason, census_failure_reason,
    child_identity_reads, zombie_observed, zombie_libproc_bytes,
    stop_signals_delivered, tracker.count, tracker.fork_tainted,
    survivor_reaped, non_child_zombie_retained, non_child_wait_attempts
  );
  close(exit_pipe);
  dispose_direct_child(fixture_child);
  if (!survivor_reaped) dispose_direct_child(survivor);
  free_owned_tree_tracker(&tracker);
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 2) return 64;
  scenario = argv[1];
  const pid_t runner = fork();
  if (runner < 0) return 87;
  if (runner == 0) return run_fixture();
  int status = 0;
  if (waitpid(runner, &status, 0) != runner || !WIFEXITED(status)) return 88;
  return WEXITSTATUS(status);
}
