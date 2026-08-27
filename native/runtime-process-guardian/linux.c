#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define MAX_CHILDREN 256
#define STABILIZE_PASSES 16
#define DRAIN_PASSES 64
#define POLL_NS 20000000L

struct child { pid_t pid; int pidfd; unsigned long long start; };
static volatile sig_atomic_t stop_requested;
static volatile sig_atomic_t claimed;
static volatile sig_atomic_t authorized;
static volatile sig_atomic_t runtime_pid;
static unsigned long long runtime_start;
static volatile sig_atomic_t claim_sender;
static volatile sig_atomic_t authorize_sender;

static void stop_handler(int value) { (void)value; stop_requested = 1; }
static void claim_handler(int value, siginfo_t *info, void *context) {
  (void)value; (void)context;
  if (info) claim_sender = info->si_pid;
}
static void authorize_handler(int value, siginfo_t *info, void *context) {
  (void)value; (void)context;
  if (info) authorize_sender = info->si_pid;
}
static int parse_pid(const char *raw, pid_t *pid) {
  char *end = NULL; errno = 0; long parsed = strtol(raw, &end, 10);
  if (errno || end == raw || *end || parsed <= 1 || parsed > INT32_MAX) return 0;
  *pid = (pid_t)parsed; return 1;
}
static int parse_u64(const char *raw, unsigned long long *value) {
  char *end = NULL; errno = 0; unsigned long long parsed = strtoull(raw, &end, 10);
  if (errno || end == raw || *end || parsed == 0) return 0;
  *value = parsed; return 1;
}
static int read_identity(pid_t pid, pid_t *parent_pid, unsigned long long *start) {
  char path[64], data[4096]; snprintf(path, sizeof(path), "/proc/%d/stat", pid);
  int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW); if (fd < 0) return 0;
  ssize_t size = read(fd, data, sizeof(data) - 1); close(fd);
  if (size <= 0 || size >= (ssize_t)sizeof(data)) return 0;
  data[size] = 0;
  char *tail = strrchr(data, ')'); int parent = 0; char state = 0;
  const int valid = tail && sscanf(tail + 2,
    "%c %d %*d %*d %*d %*d %*u %*u %*u %*u %*u %*u %*u %*d %*d %*d %*d %*d %*d %llu",
    &state, &parent, start) == 3 && *start > 0;
  if (valid && parent_pid) *parent_pid = (pid_t)parent;
  return valid;
}
static int read_start(pid_t pid, unsigned long long *start) {
  return read_identity(pid, NULL, start);
}
static int same_process(pid_t pid, unsigned long long start) {
  unsigned long long current = 0; return read_start(pid, &current) && current == start;
}
static int pidfd_open_exact(pid_t pid) {
  return (int)syscall(SYS_pidfd_open, pid, 0);
}
static int trusted_runtime_helper(pid_t sender, pid_t parent, unsigned long long parent_start) {
  pid_t sender_parent = 0; unsigned long long sender_start = 0, confirmed_start = 0;
  int pidfd = pidfd_open_exact(sender); if (pidfd < 0) return 0;
  char sender_path[64]; snprintf(sender_path, sizeof(sender_path), "/proc/%d/exe", sender);
  int sender_exe = open(sender_path, O_PATH | O_CLOEXEC);
  int self_exe = open("/proc/self/exe", O_PATH | O_CLOEXEC); struct stat left, right;
  const int valid = sender_exe >= 0 && self_exe >= 0
    && read_identity(sender, &sender_parent, &sender_start) && sender_parent == parent
    && same_process(parent, parent_start)
    && !fstat(sender_exe, &left) && !fstat(self_exe, &right)
    && left.st_dev == right.st_dev && left.st_ino == right.st_ino
    && read_start(sender, &confirmed_start) && confirmed_start == sender_start;
  if (sender_exe >= 0) close(sender_exe);
  if (self_exe >= 0) close(self_exe);
  close(pidfd);
  return valid;
}
static int pidfd_signal(int pidfd, int signal_number) {
  if (syscall(SYS_pidfd_send_signal, pidfd, signal_number, NULL, 0) == 0) return 1;
  return errno == ESRCH;
}
static void close_children(struct child *children, int count) {
  for (int index = 0; index < count; index++) close(children[index].pidfd);
}
static int census(struct child *children, int *count) {
  char path[96], data[8192];
  snprintf(path, sizeof(path), "/proc/self/task/%d/children", getpid());
  int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW); if (fd < 0) return 0;
  ssize_t size = read(fd, data, sizeof(data) - 1); close(fd);
  if (size < 0 || size >= (ssize_t)sizeof(data)) return 0;
  data[size] = 0;
  int used = 0; char *cursor = data;
  while (*cursor) {
    while (*cursor == ' ') cursor++;
    if (!*cursor) break;
    char *end = NULL; errno = 0; long raw = strtol(cursor, &end, 10);
    if (errno || end == cursor || raw <= 1 || raw > INT32_MAX || used >= MAX_CHILDREN) {
      close_children(children, used); return 0;
    }
    int pidfd = pidfd_open_exact((pid_t)raw); unsigned long long start = 0;
    if (pidfd < 0) {
      const int transient = errno == ESRCH; close_children(children, used); return transient ? -1 : 0;
    }
    if (!read_start((pid_t)raw, &start)) {
      const int transient = kill((pid_t)raw, 0) && errno == ESRCH;
      close(pidfd); close_children(children, used); return transient ? -1 : 0;
    }
    if (syscall(SYS_pidfd_send_signal, pidfd, 0, NULL, 0)) {
      const int transient = errno == ESRCH;
      close(pidfd); close_children(children, used); return transient ? -1 : 0;
    }
    children[used++] = (struct child){ .pid = (pid_t)raw, .pidfd = pidfd, .start = start };
    cursor = end;
  }
  *count = used; return 1;
}
static int same_children(const struct child *left, int left_count, const struct child *right, int right_count) {
  if (left_count != right_count) return 0;
  for (int i = 0; i < left_count; i++) {
    int found = 0;
    for (int j = 0; j < right_count; j++) if (
      left[i].pid == right[j].pid && left[i].start == right[j].start
    ) { found = 1; break; }
    if (!found) return 0;
  }
  return 1;
}
static void reap(void) { int status = 0; while (waitpid(-1, &status, WNOHANG) > 0) {} }
static int install_terminal_filter(pid_t pid, pid_t tid) {
#if defined(__x86_64__)
  const uint32_t architecture = AUDIT_ARCH_X86_64;
#elif defined(__aarch64__)
  const uint32_t architecture = AUDIT_ARCH_AARCH64;
#else
  return 0;
#endif
  struct sock_filter instructions[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, architecture, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_rt_sigreturn, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_exit, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_exit_group, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_openat, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_read, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_close, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_fstat, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_newfstatat, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_pidfd_open, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_prctl, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_tgkill, 0, 7),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (uint32_t)pid, 0, 5),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (uint32_t)tid, 0, 3),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SIGSTOP, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
  };
  const struct sock_fprog program = {
    .len = (unsigned short)(sizeof(instructions) / sizeof(instructions[0])),
    .filter = instructions,
  };
  return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) == 0;
}
static int drain(void) {
  struct timespec pause = { .tv_sec = 0, .tv_nsec = POLL_NS };
  for (int pass = 0; pass < DRAIN_PASSES; pass++) {
    struct child first[MAX_CHILDREN], second[MAX_CHILDREN]; int first_count = 0, second_count = 0;
    reap(); const int first_result = census(first, &first_count);
    if (first_result < 0) { nanosleep(&pause, NULL); continue; }
    if (!first_result) return 0;
    if (first_count == 0) {
      int status = 0; errno = 0;
      if (waitpid(-1, &status, WNOHANG) < 0 && errno == ECHILD) return 1;
      continue;
    }
    int stable = 0;
    for (int freeze = 0; freeze < STABILIZE_PASSES && !stable; freeze++) {
      for (int i = 0; i < first_count; i++) if (!pidfd_signal(first[i].pidfd, SIGSTOP)) {
        close_children(first, first_count); return 0;
      }
      nanosleep(&pause, NULL);
      const int second_result = census(second, &second_count);
      if (second_result < 0) { stable = -1; break; }
      if (!second_result) { close_children(first, first_count); return 0; }
      stable = same_children(first, first_count, second, second_count);
      if (!stable) {
        close_children(first, first_count);
        memcpy(first, second, (size_t)second_count * sizeof(*first)); first_count = second_count;
      } else close_children(second, second_count);
    }
    if (stable < 0) { close_children(first, first_count); nanosleep(&pause, NULL); continue; }
    if (!stable) { close_children(first, first_count); return 0; }
    for (int i = 0; i < first_count; i++) if (
      !pidfd_signal(first[i].pidfd, SIGTERM) || !pidfd_signal(first[i].pidfd, SIGCONT)
    ) {
      close_children(first, first_count); return 0;
    }
    for (int grace = 0; grace < 5; grace++) { nanosleep(&pause, NULL); reap(); }
    for (int i = 0; i < first_count; i++) if (!pidfd_signal(first[i].pidfd, SIGKILL)) {
      close_children(first, first_count); return 0;
    }
    close_children(first, first_count); nanosleep(&pause, NULL); reap();
  }
  return 0;
}
static int terminal_state(int clean, int status) {
  (void)prctl(PR_SET_NAME, clean ? "inertia-done" : "inertia-bad", 0, 0, 0);
  sigset_t blocked; sigfillset(&blocked); sigdelset(&blocked, SIGKILL); sigdelset(&blocked, SIGSTOP);
  sigdelset(&blocked, SIGUSR2);
  (void)sigprocmask(SIG_SETMASK, &blocked, NULL);
  const pid_t pid = getpid(); const pid_t tid = (pid_t)syscall(SYS_gettid);
  if (!install_terminal_filter(pid, tid)) {
    clean = 0;
    (void)prctl(PR_SET_NAME, "inertia-bad", 0, 0, 0);
  }
  authorize_sender = 0;
  for (;;) {
    (void)syscall(SYS_tgkill, pid, tid, SIGSTOP);
    const pid_t sender = authorize_sender; authorize_sender = 0;
    if (clean && sender && trusted_runtime_helper(sender, runtime_pid, runtime_start)) {
      (void)prctl(PR_SET_NAME, "inertia-exit", 0, 0, 0);
      return status;
    }
  }
}
static int identity_mode(const char *raw) {
  pid_t pid, parent = 0; unsigned long long start = 0; if (!parse_pid(raw, &pid)) return 64;
  if (!read_identity(pid, &parent, &start)) return kill(pid, 0) && errno == ESRCH ? 3 : 2;
  struct stat executable; if (stat("/proc/self/exe", &executable)) return 2;
  printf("%d|%d|%d|%llu|%llu|%llu\n", pid, (int)parent, (int)getpgid(pid), start,
    (unsigned long long)executable.st_dev, (unsigned long long)executable.st_ino);
  return fflush(stdout) ? 2 : 0;
}
static int hardened_status(pid_t pid) {
  char path[64], data[4096]; snprintf(path, sizeof(path), "/proc/%d/status", pid);
  int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW); if (fd < 0) return 0;
  ssize_t size = read(fd, data, sizeof(data) - 1); close(fd);
  if (size <= 0 || size >= (ssize_t)sizeof(data)) return 0;
  data[size] = 0;
  return strstr(data, "Name:\tinertia-ready\n") && strstr(data, "TracerPid:\t0\n")
    && strstr(data, "Threads:\t1\n") && strstr(data, "NoNewPrivs:\t1\n");
}
static int named_status(pid_t pid, const char *name) {
  char path[64], data[4096], expected[64]; snprintf(path, sizeof(path), "/proc/%d/status", pid);
  int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW); if (fd < 0) return 0;
  ssize_t size = read(fd, data, sizeof(data) - 1); close(fd);
  if (size <= 0 || size >= (ssize_t)sizeof(data)) return 0;
  data[size] = 0; snprintf(expected, sizeof(expected), "Name:\t%s\n", name);
  return strstr(data, expected) != NULL;
}
static int ready_mode(const char *raw) {
  pid_t pid; if (!parse_pid(raw, &pid)) return 64;
  struct timespec pause = { .tv_sec = 0, .tv_nsec = POLL_NS };
  for (int poll = 0; poll < 50; poll++) {
    if (getpgid(pid) == pid && getsid(pid) == pid && hardened_status(pid)) return identity_mode(raw);
    nanosleep(&pause, NULL);
  }
  return 4;
}
static int state_mode(const char *raw, const char *expected_name) {
  pid_t pid; if (!parse_pid(raw, &pid)) return 64;
  struct timespec pause = { .tv_sec = 0, .tv_nsec = POLL_NS };
  for (int poll = 0; poll < 50; poll++) {
    if (getpgid(pid) == pid && getsid(pid) == pid && named_status(pid, expected_name)) return identity_mode(raw);
    nanosleep(&pause, NULL);
  }
  return 4;
}
static int exact_signal_mode(int argc, char **argv) {
  if (argc != 7) return 64;
  pid_t pid; unsigned long long start, helper_device, helper_inode;
  if (!parse_pid(argv[2], &pid) || !parse_u64(argv[3], &start)
    || !parse_u64(argv[4], &helper_device) || !parse_u64(argv[5], &helper_inode)) return 64;
  struct stat helper; if (stat("/proc/self/exe", &helper)
    || (unsigned long long)helper.st_dev != helper_device
    || (unsigned long long)helper.st_ino != helper_inode) return 3;
  const char *action = argv[6]; const char *expected_name = NULL; int first_signal = 0, second_signal = 0;
  if (!strcmp(action, "claim")) { expected_name = "inertia-ready"; first_signal = SIGUSR1; }
  else if (!strcmp(action, "exec")) { expected_name = "inertia-claim"; first_signal = SIGUSR2; }
  else if (!strcmp(action, "release")) { expected_name = "inertia-done"; first_signal = SIGUSR2; second_signal = SIGCONT; }
  else if (!strcmp(action, "kill")) { expected_name = "inertia-done"; first_signal = SIGKILL; }
  else if (!strcmp(action, "stop")) { first_signal = SIGTERM; }
  else return 64;
  int pidfd = pidfd_open_exact(pid); if (pidfd < 0) return 3;
  if (!same_process(pid, start)
    || (expected_name ? !named_status(pid, expected_name)
      : !(named_status(pid, "inertia-ready") || named_status(pid, "inertia-claim")
        || named_status(pid, "inertia-owned")))) {
    close(pidfd);
    return 3;
  }
  const int valid = same_process(pid, start)
    && (expected_name ? named_status(pid, expected_name)
      : (named_status(pid, "inertia-ready") || named_status(pid, "inertia-claim")
        || named_status(pid, "inertia-owned")));
  if (!valid || syscall(SYS_pidfd_send_signal, pidfd, first_signal, NULL, 0)
    || (second_signal && syscall(SYS_pidfd_send_signal, pidfd, second_signal, NULL, 0))) {
    close(pidfd); return 3;
  }
  if (!strcmp(action, "claim") || !strcmp(action, "exec") || !strcmp(action, "release")) {
    const char *next_name = !strcmp(action, "claim") ? "inertia-claim"
      : (!strcmp(action, "exec") ? "inertia-owned" : "inertia-exit");
    struct timespec pause = { .tv_sec = 0, .tv_nsec = POLL_NS };
    for (int poll = 0; poll < 50; poll++) {
      if (named_status(pid, next_name)) { close(pidfd); return 0; }
      if (!strcmp(action, "release")) {
        errno = 0;
        if (syscall(SYS_pidfd_send_signal, pidfd, 0, NULL, 0) < 0 && errno == ESRCH) {
          close(pidfd); return 0;
        }
      }
      nanosleep(&pause, NULL);
    }
    close(pidfd); return 4;
  }
  close(pidfd); return 0;
}
static int seccomp_selftest(void) {
  const pid_t child = fork();
  if (child < 0) return 2;
  if (child == 0) {
    const pid_t pid = getpid(); const pid_t tid = (pid_t)syscall(SYS_gettid);
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || !install_terminal_filter(pid, tid)) _exit(3);
    (void)syscall(SYS_getuid);
    _exit(4);
  }
  int status = 0;
  if (waitpid(child, &status, 0) != child) return 2;
  return WIFSIGNALED(status) && WTERMSIG(status) == SIGSYS ? 0 : 1;
}
static int watch_mode(int argc, char **argv) {
  if (argc < 7 || strcmp(argv[5], "--")) return 64;
  pid_t parent; unsigned long long parent_start = 0;
  unsigned long long expected_device = 0, expected_inode = 0; struct stat self_executable;
  if (!parse_pid(argv[2], &parent) || !read_start(parent, &parent_start)
    || !parse_u64(argv[3], &expected_device) || !parse_u64(argv[4], &expected_inode)
    || stat("/proc/self/exe", &self_executable)
    || (unsigned long long)self_executable.st_dev != expected_device
    || (unsigned long long)self_executable.st_ino != expected_inode) return 69;
  if ((getsid(0) != getpid() && (getpgrp() == getpid() || setsid() != getpid()))
    || getsid(0) != getpid() || getpgrp() != getpid()
    || prctl(PR_SET_CHILD_SUBREAPER, 1) || prctl(PR_SET_DUMPABLE, 0)
    || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) return 70;
  struct sigaction stop = {0}, claim = {0}, authorize = {0};
  stop.sa_handler = stop_handler; claim.sa_sigaction = claim_handler; claim.sa_flags = SA_SIGINFO;
  authorize.sa_sigaction = authorize_handler; authorize.sa_flags = SA_SIGINFO;
  sigemptyset(&stop.sa_mask); sigemptyset(&claim.sa_mask); sigemptyset(&authorize.sa_mask);
  runtime_pid = parent; runtime_start = parent_start;
  if (sigaction(SIGTERM, &stop, NULL) || sigaction(SIGINT, &stop, NULL) || sigaction(SIGHUP, &stop, NULL)
    || sigaction(SIGUSR1, &claim, NULL) || sigaction(SIGUSR2, &authorize, NULL)) return 70;
  int gate[2]; if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, gate)) return 70;
  pid_t payload = fork(); if (payload < 0) return 70;
  if (payload == 0) {
    close(gate[1]); char byte = 0; ssize_t size;
    do { size = read(gate[0], &byte, 1); } while (size < 0 && errno == EINTR);
    close(gate[0]); if (size != 1 || byte != 'A') _exit(125);
    execvp(argv[6], &argv[6]); _exit(127);
  }
  struct child preflight_children[MAX_CHILDREN]; int preflight_count = 0;
  if (seccomp_selftest() != 0 || census(preflight_children, &preflight_count) != 1
    || preflight_count != 1 || preflight_children[0].pid != payload
    || !pidfd_signal(preflight_children[0].pidfd, 0)) {
    close_children(preflight_children, preflight_count);
    close(gate[1]); (void)waitpid(payload, NULL, 0); return 70;
  }
  close_children(preflight_children, preflight_count);
  if (prctl(PR_SET_NAME, "inertia-ready", 0, 0, 0)) return 70;
  close(gate[0]); close(STDIN_FILENO); close(STDOUT_FILENO); close(STDERR_FILENO);
  struct timespec pause = { .tv_sec = 0, .tv_nsec = POLL_NS };
  while (!claimed) {
    if (claim_sender) {
      const pid_t sender = claim_sender; claim_sender = 0;
      if (trusted_runtime_helper(sender, parent, parent_start)) claimed = 1;
    }
    if (!same_process(parent, parent_start) || stop_requested) {
      close(gate[1]); return drain() ? (stop_requested ? 143 : 137) : 127;
    }
    nanosleep(&pause, NULL);
  }
  if (!same_process(parent, parent_start)) { close(gate[1]); return terminal_state(drain(), 137); }
  if (prctl(PR_SET_NAME, "inertia-claim", 0, 0, 0)) { close(gate[1]); return terminal_state(0, 127); }
  while (!authorized) {
    if (authorize_sender) {
      const pid_t sender = authorize_sender; authorize_sender = 0;
      if (trusted_runtime_helper(sender, parent, parent_start)) authorized = 1;
    }
    if (!same_process(parent, parent_start)) { close(gate[1]); return terminal_state(drain(), 137); }
    if (stop_requested) { close(gate[1]); return terminal_state(drain(), 143); }
    nanosleep(&pause, NULL);
  }
  if (!same_process(parent, parent_start)) { close(gate[1]); return terminal_state(drain(), 137); }
  if (prctl(PR_SET_NAME, "inertia-owned", 0, 0, 0)) { close(gate[1]); return terminal_state(0, 127); }
  if (write(gate[1], "A", 1) != 1) { close(gate[1]); return terminal_state(0, 127); }
  close(gate[1]); int status = 0;
  for (;;) {
    pid_t waited = waitpid(payload, &status, WNOHANG);
    if (waited == payload) {
      int result = WIFEXITED(status) ? WEXITSTATUS(status) : (WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 127);
      return terminal_state(drain(), result);
    }
    if (waited < 0 && errno != EINTR) return terminal_state(0, 127);
    if (!same_process(parent, parent_start)) return terminal_state(drain(), 137);
    if (stop_requested) return terminal_state(drain(), 143);
    nanosleep(&pause, NULL);
  }
}
int main(int argc, char **argv) {
  const struct rlimit no_core = { .rlim_cur = 0, .rlim_max = 0 };
  if (setrlimit(RLIMIT_CORE, &no_core)) return 70;
  if (argc == 2 && !strcmp(argv[1], "seccomp-selftest")) return seccomp_selftest();
  if (argc == 3 && !strcmp(argv[1], "identity")) return identity_mode(argv[2]);
  if (argc == 3 && !strcmp(argv[1], "ready")) return ready_mode(argv[2]);
  if (argc == 3 && !strcmp(argv[1], "claimed")) return state_mode(argv[2], "inertia-claim");
  if (argc == 3 && !strcmp(argv[1], "owned")) return state_mode(argv[2], "inertia-owned");
  if (argc >= 2 && !strcmp(argv[1], "signal")) return exact_signal_mode(argc, argv);
  if (argc >= 5 && !strcmp(argv[1], "watch")) return watch_mode(argc, argv);
  return 64;
}
