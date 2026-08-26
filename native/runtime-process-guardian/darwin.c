#include <errno.h>
#include <libproc.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define MAX_GROUP_PIDS 4096
#define POLL_NANOSECONDS 20000000L
#define TERM_GRACE_POLLS 5

static volatile sig_atomic_t stop_requested = 0;

static void request_stop(int signal_number) {
  (void)signal_number;
  stop_requested = 1;
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

static int list_group_members(pid_t process_group, pid_t *members, int capacity) {
  const int bytes = proc_listpids(
    PROC_PGRP_ONLY,
    (uint32_t)process_group,
    members,
    capacity * (int)sizeof(*members)
  );
  if (bytes < 0) return -1;
  return bytes / (int)sizeof(*members);
}

static void signal_group_members(pid_t process_group, int signal_number) {
  pid_t members[MAX_GROUP_PIDS];
  const int count = list_group_members(process_group, members, MAX_GROUP_PIDS);
  if (count < 0) return;
  const pid_t self = getpid();
  for (int index = 0; index < count; index += 1) {
    const pid_t member = members[index];
    if (member > 1 && member != self) {
      (void)kill(member, signal_number);
    }
  }
}

static int group_has_other_members(pid_t process_group) {
  pid_t members[MAX_GROUP_PIDS];
  const int count = list_group_members(process_group, members, MAX_GROUP_PIDS);
  if (count < 0) return 1;
  const pid_t self = getpid();
  for (int index = 0; index < count; index += 1) {
    if (members[index] > 1 && members[index] != self) return 1;
  }
  return 0;
}

static void bounded_group_cleanup(pid_t process_group) {
  signal_group_members(process_group, SIGTERM);
  const struct timespec pause = { .tv_sec = 0, .tv_nsec = POLL_NANOSECONDS };
  for (int poll = 0; poll < TERM_GRACE_POLLS; poll += 1) {
    if (!group_has_other_members(process_group)) return;
    (void)nanosleep(&pause, NULL);
  }
  signal_group_members(process_group, SIGKILL);
}

static int identity_mode(const char *raw_pid) {
  pid_t pid = 0;
  struct proc_bsdinfo identity;
  if (!parse_pid(raw_pid, &pid)) return 64;
  if (!read_identity(pid, &identity)) {
    if (kill(pid, 0) != 0 && errno == ESRCH) return 3;
    return 2;
  }
  if (printf(
    "%u|%u|%u|%llu|%llu\n",
    identity.pbi_pid,
    identity.pbi_ppid,
    identity.pbi_pgid,
    identity.pbi_start_tvsec,
    identity.pbi_start_tvusec
  ) < 0) return 2;
  return fflush(stdout) == 0 ? 0 : 2;
}

static int watch_mode(int argc, char *argv[]) {
  if (argc < 5 || strcmp(argv[3], "--") != 0) return 64;
  pid_t runtime_pid = 0;
  if (!parse_pid(argv[2], &runtime_pid)) return 64;

  struct proc_bsdinfo runtime_identity;
  if (!read_identity(runtime_pid, &runtime_identity)) return 69;

  const pid_t self = getpid();
  if (getpgrp() != self && setpgid(0, 0) != 0) return 70;
  if (getpgrp() != self) return 70;

  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = request_stop;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) != 0
    || sigaction(SIGINT, &action, NULL) != 0
    || sigaction(SIGHUP, &action, NULL) != 0) return 70;

  const pid_t child = fork();
  if (child < 0) return 71;
  if (child == 0) {
    execvp(argv[4], &argv[4]);
    _exit(errno == ENOENT ? 127 : 126);
  }

  const struct timespec pause = { .tv_sec = 0, .tv_nsec = POLL_NANOSECONDS };
  int status = 0;
  int result = 137;
  for (;;) {
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
    struct proc_bsdinfo current_runtime;
    if (stop_requested
      || !read_identity(runtime_pid, &current_runtime)
      || !same_identity(&runtime_identity, &current_runtime)) {
      result = 137;
      break;
    }
    (void)nanosleep(&pause, NULL);
  }

  bounded_group_cleanup(self);
  return result;
}

int main(int argc, char *argv[]) {
  if (argc == 3 && strcmp(argv[1], "identity") == 0) {
    return identity_mode(argv[2]);
  }
  if (argc >= 5 && strcmp(argv[1], "watch") == 0) {
    return watch_mode(argc, argv);
  }
  return 64;
}
