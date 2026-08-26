#include <errno.h>
#include <libproc.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/socket.h>
#include <sys/sysctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define HARD_MAX_PROCESSES 65536
#define SESSION_FREEZE_PASSES 16
#define SESSION_DRAIN_POLLS 50
#define TERM_GRACE_POLLS 5
#define GUARDIAN_READY_POLLS 50
#define POLL_NANOSECONDS 20000000L

struct session_member {
  struct proc_bsdinfo identity;
};

struct owned_tree_tracker {
  int capacity;
  int count;
  struct session_member *members;
  struct session_member *previous;
  struct session_member *all;
  unsigned char *owned;
  int root_event_queue;
  int fork_tainted;
};

static volatile sig_atomic_t stop_requested = 0;
static volatile sig_atomic_t authorization_requested = 0;
static volatile sig_atomic_t authorization_runtime_pid = 0;

static void request_stop(int signal_number) {
  (void)signal_number;
  stop_requested = 1;
}

static void request_authorization(
  int signal_number,
  siginfo_t *information,
  void *context
) {
  (void)signal_number;
  (void)context;
  if (information != NULL
    && information->si_pid == authorization_runtime_pid) {
    authorization_requested = 1;
  }
}

static void terminate_with_uncertain_containment(void) {
  // A signal is an unambiguous guardian-level marker: payload signals are
  // translated into ordinary numeric exit statuses by the guardian. Restore
  // and unblock SIGUSR2 so inherited process state cannot suppress it. If the
  // marker setup itself fails, SIGKILL remains an abnormal guardian exit and
  // therefore also retains the durable ownership claim.
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = SIG_DFL;
  sigemptyset(&action.sa_mask);
  sigset_t marker;
  sigemptyset(&marker);
  sigaddset(&marker, SIGUSR2);
  if (sigaction(SIGUSR2, &action, NULL) == 0
    && sigprocmask(SIG_UNBLOCK, &marker, NULL) == 0) {
    (void)raise(SIGUSR2);
  }
  (void)kill(getpid(), SIGKILL);
  _exit(127);
}

static int read_identity(pid_t pid, struct proc_bsdinfo *info) {
  memset(info, 0, sizeof(*info));
  const int bytes = proc_pidinfo(
    pid,
    PROC_PIDTBSDINFO,
    0,
    info,
    (int)sizeof(*info)
  );
  return bytes == (int)sizeof(*info) && info->pbi_pid == (uint32_t)pid;
}

static int same_identity(
  const struct proc_bsdinfo *left,
  const struct proc_bsdinfo *right
) {
  return left->pbi_pid == right->pbi_pid
    && left->pbi_start_tvsec == right->pbi_start_tvsec
    && left->pbi_start_tvusec == right->pbi_start_tvusec;
}

static int compare_session_members(const void *raw_left, const void *raw_right) {
  const struct session_member *left = raw_left;
  const struct session_member *right = raw_right;
  if (left->identity.pbi_pid < right->identity.pbi_pid) return -1;
  if (left->identity.pbi_pid > right->identity.pbi_pid) return 1;
  if (left->identity.pbi_start_tvsec < right->identity.pbi_start_tvsec) return -1;
  if (left->identity.pbi_start_tvsec > right->identity.pbi_start_tvsec) return 1;
  if (left->identity.pbi_start_tvusec < right->identity.pbi_start_tvusec) return -1;
  if (left->identity.pbi_start_tvusec > right->identity.pbi_start_tvusec) return 1;
  return 0;
}

static int process_scan_capacity(void) {
  int max_processes = 0;
  size_t size = sizeof(max_processes);
  if (sysctlbyname("kern.maxproc", &max_processes, &size, NULL, 0) != 0
    || size != sizeof(max_processes)
    || max_processes < 1
    || max_processes > HARD_MAX_PROCESSES) return -1;
  return max_processes + 1;
}

static int parse_pid(const char *value, pid_t *pid) {
  char *end = NULL;
  errno = 0;
  const long parsed = strtol(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || parsed <= 1 || parsed > INT32_MAX) {
    return 0;
  }
  *pid = (pid_t)parsed;
  return 1;
}

static int list_session_members(
  pid_t session_id,
  pid_t excluded_pid,
  struct session_member *members,
  int capacity
) {
  pid_t *pids = calloc((size_t)capacity, sizeof(*pids));
  if (pids == NULL) return -1;
  const int buffer_bytes = capacity * (int)sizeof(*pids);
  const int bytes = proc_listpids(PROC_ALL_PIDS, 0, pids, buffer_bytes);
  if (bytes < 0
    || bytes % (int)sizeof(*pids) != 0
    || bytes >= buffer_bytes) {
    free(pids);
    return -1;
  }
  const int pid_count = bytes / (int)sizeof(*pids);
  int member_count = 0;
  for (int index = 0; index < pid_count; index += 1) {
    const pid_t pid = pids[index];
    if (pid <= 1 || pid == excluded_pid) continue;
    errno = 0;
    const pid_t observed_session = getsid(pid);
    if (observed_session < 0) {
      if (errno == ESRCH) continue;
      free(pids);
      return -1;
    }
    if (observed_session != session_id) continue;
    struct proc_bsdinfo identity;
    if (!read_identity(pid, &identity)) {
      if (kill(pid, 0) != 0 && errno == ESRCH) continue;
      free(pids);
      return -1;
    }
    if (member_count >= capacity) {
      free(pids);
      return -1;
    }
    members[member_count].identity = identity;
    member_count += 1;
  }
  free(pids);
  qsort(
    members,
    (size_t)member_count,
    sizeof(*members),
    compare_session_members
  );
  return member_count;
}

static int list_all_members(
  pid_t session_id,
  pid_t excluded_pid,
  struct session_member *members,
  int capacity,
  const struct owned_tree_tracker *tracker
) {
  pid_t *pids = calloc((size_t)capacity, sizeof(*pids));
  if (pids == NULL) return -1;
  const int buffer_bytes = capacity * (int)sizeof(*pids);
  const int bytes = proc_listpids(PROC_ALL_PIDS, 0, pids, buffer_bytes);
  if (bytes < 0
    || bytes % (int)sizeof(*pids) != 0
    || bytes >= buffer_bytes) {
    free(pids);
    return -1;
  }
  const int pid_count = bytes / (int)sizeof(*pids);
  int member_count = 0;
  for (int index = 0; index < pid_count; index += 1) {
    const pid_t pid = pids[index];
    if (pid <= 1 || pid == excluded_pid) continue;
    struct proc_bsdinfo identity;
    if (!read_identity(pid, &identity)) {
      if (kill(pid, 0) != 0 && errno == ESRCH) continue;
      int must_inspect = 0;
      errno = 0;
      const pid_t observed_session = getsid(pid);
      must_inspect = observed_session == session_id;
      for (int tracked = 0;
        !must_inspect && tracked < tracker->count;
        tracked += 1) {
        must_inspect = tracker->members[tracked].identity.pbi_pid
          == (uint32_t)pid;
      }
      if (!must_inspect) continue;
      free(pids);
      return -1;
    }
    if (member_count >= capacity) {
      free(pids);
      return -1;
    }
    members[member_count].identity = identity;
    member_count += 1;
  }
  free(pids);
  qsort(
    members,
    (size_t)member_count,
    sizeof(*members),
    compare_session_members
  );
  return member_count;
}

static int member_index_by_pid(
  const struct session_member *members,
  int count,
  pid_t pid
) {
  int low = 0;
  int high = count - 1;
  while (low <= high) {
    const int middle = low + ((high - low) / 2);
    const pid_t candidate = (pid_t)members[middle].identity.pbi_pid;
    if (candidate == pid) return middle;
    if (candidate < pid) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

static int tracked_identity(
  const struct owned_tree_tracker *tracker,
  const struct proc_bsdinfo *identity
) {
  const int index = member_index_by_pid(
    tracker->members,
    tracker->count,
    (pid_t)identity->pbi_pid
  );
  return index >= 0 && same_identity(&tracker->members[index].identity, identity);
}

static int refresh_owned_tree(
  pid_t session_id,
  pid_t guardian_pid,
  struct owned_tree_tracker *tracker
) {
  const int count = list_all_members(
    session_id,
    guardian_pid,
    tracker->all,
    tracker->capacity,
    tracker
  );
  if (count < 0) return 0;
  memset(tracker->owned, 0, (size_t)tracker->capacity);
  for (int index = 0; index < count; index += 1) {
    const struct proc_bsdinfo *identity = &tracker->all[index].identity;
    const int was_tracked = tracked_identity(tracker, identity);
    errno = 0;
    const pid_t observed_session = getsid((pid_t)identity->pbi_pid);
    if (observed_session < 0) {
      if (was_tracked) tracker->owned[index] = 1;
      continue;
    }
    if (observed_session == session_id || was_tracked) {
      tracker->owned[index] = 1;
    }
  }
  int changed = 1;
  for (int pass = 0; changed && pass < count; pass += 1) {
    changed = 0;
    for (int index = 0; index < count; index += 1) {
      if (tracker->owned[index]) continue;
      const pid_t parent = (pid_t)tracker->all[index].identity.pbi_ppid;
      const int parent_index = member_index_by_pid(tracker->all, count, parent);
      if (parent == guardian_pid
        || (parent_index >= 0 && tracker->owned[parent_index])) {
        tracker->owned[index] = 1;
        changed = 1;
      }
    }
  }
  int owned_count = 0;
  for (int index = 0; index < count; index += 1) {
    if (!tracker->owned[index]) continue;
    if (owned_count >= tracker->capacity) return 0;
    tracker->previous[owned_count] = tracker->all[index];
    owned_count += 1;
  }
  struct session_member *swap = tracker->members;
  tracker->members = tracker->previous;
  tracker->previous = swap;
  tracker->count = owned_count;
  return 1;
}

static int arm_root_fork_observer(
  struct owned_tree_tracker *tracker,
  pid_t root_pid
) {
  tracker->root_event_queue = kqueue();
  if (tracker->root_event_queue < 0) return 0;
  struct kevent change;
  EV_SET(
    &change,
    (uintptr_t)root_pid,
    EVFILT_PROC,
    EV_ADD | EV_ENABLE | EV_CLEAR,
    NOTE_FORK | NOTE_EXIT,
    0,
    NULL
  );
  return kevent(
    tracker->root_event_queue,
    &change,
    1,
    NULL,
    0,
    NULL
  ) == 0;
}

static void observe_root_forks(struct owned_tree_tracker *tracker) {
  if (tracker->root_event_queue < 0) return;
  const struct timespec immediate = { .tv_sec = 0, .tv_nsec = 0 };
  for (int pass = 0; pass < SESSION_FREEZE_PASSES; pass += 1) {
    struct kevent events[8];
    const int count = kevent(
      tracker->root_event_queue,
      NULL,
      0,
      events,
      8,
      &immediate
    );
    if (count < 0) {
      tracker->fork_tainted = 1;
      return;
    }
    for (int index = 0; index < count; index += 1) {
      if ((events[index].flags & EV_ERROR) != 0) {
        tracker->fork_tainted = 1;
      }
      if ((events[index].fflags & NOTE_FORK) != 0) {
        // macOS removed NOTE_TRACK/NOTE_CHILD in 10.5, and NOTE_FORK does not
        // identify the child. A child can therefore double-fork, call setsid,
        // and reparent before any userspace census. Keep this taint permanent:
        // known processes are still drained, but the guardian must exit with
        // the distinct uncertain-containment status so the journal claim is
        // preserved for explicit recovery rather than looking proven.
        tracker->fork_tainted = 1;
      }
    }
    if (count < 8) return;
  }
  tracker->fork_tainted = 1;
}

static int initialize_owned_tree_tracker(struct owned_tree_tracker *tracker) {
  memset(tracker, 0, sizeof(*tracker));
  tracker->root_event_queue = -1;
  tracker->capacity = process_scan_capacity();
  if (tracker->capacity < 1) return 0;
  tracker->members = calloc((size_t)tracker->capacity, sizeof(*tracker->members));
  tracker->previous = calloc((size_t)tracker->capacity, sizeof(*tracker->previous));
  tracker->all = calloc((size_t)tracker->capacity, sizeof(*tracker->all));
  tracker->owned = calloc((size_t)tracker->capacity, sizeof(*tracker->owned));
  return tracker->members != NULL
    && tracker->previous != NULL
    && tracker->all != NULL
    && tracker->owned != NULL;
}

static void free_owned_tree_tracker(struct owned_tree_tracker *tracker) {
  if (tracker->root_event_queue >= 0) (void)close(tracker->root_event_queue);
  free(tracker->members);
  free(tracker->previous);
  free(tracker->all);
  free(tracker->owned);
  memset(tracker, 0, sizeof(*tracker));
  tracker->root_event_queue = -1;
}

static int same_member_sets(
  const struct session_member *left,
  int left_count,
  const struct session_member *right,
  int right_count
) {
  if (left_count != right_count) return 0;
  for (int index = 0; index < left_count; index += 1) {
    if (!same_identity(
      &left[index].identity,
      &right[index].identity
    )) return 0;
  }
  return 1;
}

static int signal_exact_owned_member(
  const struct session_member *member,
  int signal_number
) {
  const pid_t pid = (pid_t)member->identity.pbi_pid;
  struct proc_bsdinfo current;
  if (!read_identity(pid, &current)) {
    if (kill(pid, 0) != 0 && errno == ESRCH) return 1;
    return 0;
  }
  if (!same_identity(&member->identity, &current)) return 0;
  if (kill(pid, signal_number) == 0) return 1;
  return errno == ESRCH;
}

static void reap_children(void) {
  int status = 0;
  while (waitpid(-1, &status, WNOHANG) > 0) {}
}

static int freeze_owned_tree(
  pid_t session_id,
  pid_t guardian_pid,
  struct owned_tree_tracker *tracker
) {
  for (int pass = 0; pass < SESSION_FREEZE_PASSES; pass += 1) {
    observe_root_forks(tracker);
    // A direct child that has exited can remain as a zombie until the guardian
    // reaps it; libproc intentionally exposes no usable birth identity for
    // that state. Reap before each proof scan so a dead tracked root cannot
    // turn an otherwise empty tree into a permanent unreadable boundary.
    reap_children();
    observe_root_forks(tracker);
    if (!refresh_owned_tree(session_id, guardian_pid, tracker)) return 0;
    memcpy(
      tracker->previous,
      tracker->members,
      (size_t)tracker->count * sizeof(*tracker->members)
    );
    const int previous_count = tracker->count;
    for (int index = 0; index < previous_count; index += 1) {
      if (!signal_exact_owned_member(&tracker->previous[index], SIGSTOP)) return 0;
    }
    const struct timespec pause = { .tv_sec = 0, .tv_nsec = POLL_NANOSECONDS };
    (void)nanosleep(&pause, NULL);
    reap_children();
    if (!refresh_owned_tree(session_id, guardian_pid, tracker)) return 0;
    if (same_member_sets(
      tracker->previous,
      previous_count,
      tracker->members,
      tracker->count
    )) return 1;
  }
  return 0;
}

static int bounded_owned_tree_cleanup(
  pid_t session_id,
  pid_t guardian_pid,
  struct owned_tree_tracker *tracker
) {
  if (!freeze_owned_tree(session_id, guardian_pid, tracker)) return 0;
  for (int index = 0; index < tracker->count; index += 1) {
    if (!signal_exact_owned_member(&tracker->members[index], SIGTERM)) return 0;
  }
  const struct timespec pause = { .tv_sec = 0, .tv_nsec = POLL_NANOSECONDS };
  for (int poll = 0; poll < TERM_GRACE_POLLS; poll += 1) {
    (void)nanosleep(&pause, NULL);
    reap_children();
    if (!refresh_owned_tree(session_id, guardian_pid, tracker)) return 0;
    if (tracker->count == 0) return tracker->fork_tainted ? 0 : 1;
  }
  // Do not resume the stable frozen set to deliver TERM: a resumed signal
  // handler could fork and reparent a fresh setsid child between bounded
  // ancestry scans. TERM remains pending during the short grace interval;
  // exact survivors are then killed without reopening that escape window.
  if (!freeze_owned_tree(session_id, guardian_pid, tracker)) return 0;
  for (int index = 0; index < tracker->count; index += 1) {
    if (!signal_exact_owned_member(&tracker->members[index], SIGKILL)) return 0;
  }
  for (int poll = 0; poll < SESSION_DRAIN_POLLS; poll += 1) {
    reap_children();
    observe_root_forks(tracker);
    if (!refresh_owned_tree(session_id, guardian_pid, tracker)) return 0;
    if (tracker->count == 0) return tracker->fork_tainted ? 0 : 1;
    (void)nanosleep(&pause, NULL);
  }
  return 0;
}

static int drain_owned_tree(
  pid_t session_id,
  pid_t guardian_pid,
  struct owned_tree_tracker *tracker
) {
  // One complete attempt is bounded by the stable-freeze and drain poll caps.
  // Failure—fork taint, an unstable/capped census, or a stubborn exact
  // member—must leave durable ownership evidence rather than keeping an
  // invisible guardian alive indefinitely or pretending cleanup succeeded.
  const int drained = bounded_owned_tree_cleanup(
    session_id,
    guardian_pid,
    tracker
  );
#if defined(INERTIA_RUNTIME_GUARDIAN_TEST_CLEANUP_UNPROVED)
  // Focused native tests compile a separate, unpackaged guardian with this
  // macro to prove that a cleanup proof failure is propagated even when no
  // fork event tainted the exact payload root. Production builds never define
  // the macro and therefore return the real bounded-cleanup result.
  (void)drained;
  return 0;
#else
  return drained;
#endif
}

static int identity_mode(const char *raw_pid) {
  pid_t pid = 0;
  struct proc_bsdinfo identity;
  if (!parse_pid(raw_pid, &pid)) return 64;
  if (!read_identity(pid, &identity)) {
    if (kill(pid, 0) != 0 && errno == ESRCH) return 3;
    return 2;
  }
  const pid_t session_id = getsid(pid);
  if (session_id <= 1) return 2;
  if (printf(
    "%u|%u|%u|%u|%llu|%llu\n",
    identity.pbi_pid,
    identity.pbi_ppid,
    identity.pbi_pgid,
    (uint32_t)session_id,
    identity.pbi_start_tvsec,
    identity.pbi_start_tvusec
  ) < 0) return 2;
  return fflush(stdout) == 0 ? 0 : 2;
}

static int guardian_signal_handlers_ready(pid_t pid) {
  int query[] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, pid };
  struct kinfo_proc process;
  memset(&process, 0, sizeof(process));
  size_t size = sizeof(process);
  if (sysctl(query, 4, &process, &size, NULL, 0) != 0) {
    return errno == ESRCH ? 0 : -1;
  }
  if (size != sizeof(process) || process.kp_proc.p_pid != pid) return -1;
  return sigismember(&process.kp_proc.p_sigcatch, SIGTERM) == 1
    && sigismember(&process.kp_proc.p_sigcatch, SIGINT) == 1
    && sigismember(&process.kp_proc.p_sigcatch, SIGHUP) == 1
    && sigismember(&process.kp_proc.p_sigcatch, SIGUSR1) == 1;
}

static int ready_mode(const char *raw_pid) {
  pid_t pid = 0;
  if (!parse_pid(raw_pid, &pid)) return 64;
  struct proc_bsdinfo initial_identity;
  if (!read_identity(pid, &initial_identity)) {
    if (kill(pid, 0) != 0 && errno == ESRCH) return 3;
    return 2;
  }
  const struct timespec pause = { .tv_sec = 0, .tv_nsec = POLL_NANOSECONDS };
  for (int poll = 0; poll < GUARDIAN_READY_POLLS; poll += 1) {
    struct proc_bsdinfo identity;
    if (!read_identity(pid, &identity)) {
      if (kill(pid, 0) != 0 && errno == ESRCH) return 3;
      return 2;
    }
    if (!same_identity(&initial_identity, &identity)) return 3;
    const pid_t session_id = getsid(pid);
    if (session_id <= 1) {
      if (session_id < 0 && errno == ESRCH) return 3;
      return 2;
    }
    const int handlers_ready = guardian_signal_handlers_ready(pid);
    if (handlers_ready < 0) return 2;
    if (identity.pbi_pgid == (uint32_t)pid
      && session_id == pid
      && handlers_ready == 1) {
      if (printf(
        "%u|%u|%u|%u|%llu|%llu\n",
        identity.pbi_pid,
        identity.pbi_ppid,
        identity.pbi_pgid,
        (uint32_t)session_id,
        identity.pbi_start_tvsec,
        identity.pbi_start_tvusec
      ) < 0) return 2;
      return fflush(stdout) == 0 ? 0 : 2;
    }
    (void)nanosleep(&pause, NULL);
  }
  return 4;
}

static int session_empty_mode(const char *raw_session_id) {
  pid_t session_id = 0;
  if (!parse_pid(raw_session_id, &session_id)) return 64;
  const int capacity = process_scan_capacity();
  if (capacity < 1) return 2;
  struct session_member *members = calloc((size_t)capacity, sizeof(*members));
  if (members == NULL) return 2;
  const int count = list_session_members(session_id, 0, members, capacity);
  free(members);
  if (count < 0) return 2;
  return count == 0 ? 0 : 4;
}

static int watch_mode(int argc, char *argv[]) {
  if (argc < 5 || strcmp(argv[3], "--") != 0) return 64;
  pid_t runtime_pid = 0;
  if (!parse_pid(argv[2], &runtime_pid)) return 64;

  struct proc_bsdinfo runtime_identity;
  if (!read_identity(runtime_pid, &runtime_identity)) return 69;

  sigset_t guarded_signals;
  sigset_t previous_signals;
  sigemptyset(&guarded_signals);
  sigaddset(&guarded_signals, SIGTERM);
  sigaddset(&guarded_signals, SIGINT);
  sigaddset(&guarded_signals, SIGHUP);
  sigaddset(&guarded_signals, SIGUSR1);
  if (sigprocmask(SIG_BLOCK, &guarded_signals, &previous_signals) != 0) return 70;

  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = request_stop;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) != 0
    || sigaction(SIGINT, &action, NULL) != 0
    || sigaction(SIGHUP, &action, NULL) != 0) return 70;
  struct sigaction authorization_action;
  memset(&authorization_action, 0, sizeof(authorization_action));
  authorization_action.sa_sigaction = request_authorization;
  authorization_action.sa_flags = SA_SIGINFO;
  sigemptyset(&authorization_action.sa_mask);
  authorization_runtime_pid = (sig_atomic_t)runtime_pid;
  if (sigaction(SIGUSR1, &authorization_action, NULL) != 0) return 70;

  // PID=PGID=SID is the durable readiness boundary read by the parent. Install
  // cleanup handlers first so an admitted guardian can never be terminated
  // through the default signal disposition without draining its session.
  const pid_t self = getpid();
  if (getsid(0) != self) {
    if (getpgrp() == self || setsid() != self) return 70;
  }
  if (getsid(0) != self || getpgrp() != self) return 70;

  struct owned_tree_tracker tracker;
  if (!initialize_owned_tree_tracker(&tracker)) {
    free_owned_tree_tracker(&tracker);
    return 70;
  }

  const struct timespec pause = { .tv_sec = 0, .tv_nsec = POLL_NANOSECONDS };
  if (sigprocmask(SIG_SETMASK, &previous_signals, NULL) != 0) {
    free_owned_tree_tracker(&tracker);
    return 70;
  }
  while (!authorization_requested) {
    struct proc_bsdinfo current_runtime;
    if (stop_requested
      || !read_identity(runtime_pid, &current_runtime)
      || !same_identity(&runtime_identity, &current_runtime)) {
      const int drained = drain_owned_tree(self, self, &tracker);
      free_owned_tree_tracker(&tracker);
      if (!drained) terminate_with_uncertain_containment();
      return 137;
    }
    (void)nanosleep(&pause, NULL);
  }
  if (sigprocmask(SIG_BLOCK, &guarded_signals, NULL) != 0) {
    free_owned_tree_tracker(&tracker);
    return 70;
  }
  struct proc_bsdinfo authorized_runtime;
  if (stop_requested
    || !read_identity(runtime_pid, &authorized_runtime)
    || !same_identity(&runtime_identity, &authorized_runtime)) {
    const int drained = drain_owned_tree(self, self, &tracker);
    free_owned_tree_tracker(&tracker);
    if (!drained) terminate_with_uncertain_containment();
    return 137;
  }

  int execution_gate[2] = { -1, -1 };
  const int no_sigpipe = 1;
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, execution_gate) != 0
    || setsockopt(
      execution_gate[1],
      SOL_SOCKET,
      SO_NOSIGPIPE,
      &no_sigpipe,
      sizeof(no_sigpipe)
    ) != 0) {
    if (execution_gate[0] >= 0) (void)close(execution_gate[0]);
    if (execution_gate[1] >= 0) (void)close(execution_gate[1]);
    free_owned_tree_tracker(&tracker);
    return 71;
  }
  const pid_t child = fork();
  if (child < 0) {
    (void)close(execution_gate[0]);
    (void)close(execution_gate[1]);
    free_owned_tree_tracker(&tracker);
    return 71;
  }
  if (child == 0) {
    (void)close(execution_gate[1]);
    char authorization = 0;
    ssize_t bytes = -1;
    do {
      bytes = read(execution_gate[0], &authorization, sizeof(authorization));
    } while (bytes < 0 && errno == EINTR);
    (void)close(execution_gate[0]);
    if (bytes != 1 || authorization != 'A') _exit(125);
    if (sigprocmask(SIG_SETMASK, &previous_signals, NULL) != 0) _exit(126);
    execvp(argv[4], &argv[4]);
    _exit(errno == ENOENT ? 127 : 126);
  }
  (void)close(execution_gate[0]);
  struct proc_bsdinfo child_identity;
  const int child_identity_read = read_identity(child, &child_identity);
  // The payload remains blocked on its private socket until the exact root
  // birth identity is both watched for fork events and present in the first
  // owned census. It cannot exec or fork inside the pre-claim discovery gap.
  const int observer_armed = child_identity_read
    && arm_root_fork_observer(&tracker, child);
  const int initial_census = observer_armed
    && refresh_owned_tree(self, self, &tracker);
  const int child_index = initial_census
    ? member_index_by_pid(tracker.members, tracker.count, child)
    : -1;
  const int child_tracked = child_index >= 0
    && same_identity(&tracker.members[child_index].identity, &child_identity);
  const char authorization = 'A';
  const int execution_released = child_tracked
    && write(execution_gate[1], &authorization, sizeof(authorization)) == 1;
  (void)close(execution_gate[1]);
  if (!execution_released) {
    const int drained = drain_owned_tree(self, self, &tracker);
    free_owned_tree_tracker(&tracker);
    if (!drained) terminate_with_uncertain_containment();
    return 137;
  }
  if (sigprocmask(SIG_SETMASK, &previous_signals, NULL) != 0) {
    const int drained = drain_owned_tree(self, self, &tracker);
    free_owned_tree_tracker(&tracker);
    if (!drained) terminate_with_uncertain_containment();
    return 137;
  }

  int status = 0;
  int result = 137;
  for (;;) {
    observe_root_forks(&tracker);
    const pid_t waited = waitpid(child, &status, WNOHANG);
    if (waited == child) {
      if (WIFEXITED(status)) result = WEXITSTATUS(status);
      else if (WIFSIGNALED(status)) result = 128 + WTERMSIG(status);
      else result = 1;
      break;
    }
    if (waited < 0 && errno != EINTR) {
      result = 1;
      break;
    }
    // Reap the exact root before a privileged census. On macOS libproc does
    // not return a complete birth identity for a zombie, while kill(pid, 0)
    // still reports it present. Scanning first would therefore turn every
    // quick, ordinary payload exit into an unproved cleanup even though the
    // guardian can reap that exact child here.
    if (!refresh_owned_tree(self, self, &tracker)) {
      result = 137;
      break;
    }
    struct proc_bsdinfo current_runtime;
    if (stop_requested
      || !read_identity(runtime_pid, &current_runtime)
      || !same_identity(&runtime_identity, &current_runtime)) {
      result = 137;
      break;
    }
    (void)nanosleep(&pause, NULL);
  }

  const int drained = drain_owned_tree(self, self, &tracker);
  free_owned_tree_tracker(&tracker);
  if (!drained) terminate_with_uncertain_containment();
  return result;
}

int main(int argc, char *argv[]) {
  if (argc == 3 && strcmp(argv[1], "identity") == 0) {
    return identity_mode(argv[2]);
  }
  if (argc == 3 && strcmp(argv[1], "session-empty") == 0) {
    return session_empty_mode(argv[2]);
  }
  if (argc == 3 && strcmp(argv[1], "ready") == 0) {
    return ready_mode(argv[2]);
  }
  if (argc >= 5 && strcmp(argv[1], "watch") == 0) {
    return watch_mode(argc, argv);
  }
  return 64;
}
