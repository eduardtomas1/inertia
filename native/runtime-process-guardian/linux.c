#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <poll.h>
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
#ifndef MFD_CLOEXEC
#define MFD_CLOEXEC 0x0001U
#endif
#ifndef MFD_ALLOW_SEALING
#define MFD_ALLOW_SEALING 0x0002U
#endif
#ifndef MFD_EXEC
#define MFD_EXEC 0x0010U
#endif
#ifndef F_SEAL_EXEC
#define F_SEAL_EXEC 0x0020U
#endif

struct child { pid_t pid; int pidfd; unsigned long long start; };
struct sha256_context {
  uint32_t state[8];
  uint64_t bit_count;
  unsigned char block[64];
  size_t used;
};
static volatile sig_atomic_t stop_requested;
static volatile sig_atomic_t stop_pending_requested;
static volatile sig_atomic_t claimed;
static volatile sig_atomic_t authorized;
static volatile sig_atomic_t runtime_pid;
static unsigned long long runtime_start;
static volatile sig_atomic_t claim_sender;
static volatile sig_atomic_t authorize_sender;

static const uint32_t sha256_constants[64] = {
  0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U,
  0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
  0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U,
  0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
  0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU,
  0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
  0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U,
  0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
  0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U,
  0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
  0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U,
  0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
  0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U,
  0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
  0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U,
  0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U,
};

static uint32_t rotate_right(uint32_t value, unsigned int count) {
  return (value >> count) | (value << (32U - count));
}
static void sha256_transform(struct sha256_context *context) {
  uint32_t words[64];
  for (size_t index = 0; index < 16; index++) {
    const size_t offset = index * 4;
    words[index] = ((uint32_t)context->block[offset] << 24)
      | ((uint32_t)context->block[offset + 1] << 16)
      | ((uint32_t)context->block[offset + 2] << 8)
      | (uint32_t)context->block[offset + 3];
  }
  for (size_t index = 16; index < 64; index++) {
    const uint32_t first = rotate_right(words[index - 15], 7)
      ^ rotate_right(words[index - 15], 18) ^ (words[index - 15] >> 3);
    const uint32_t second = rotate_right(words[index - 2], 17)
      ^ rotate_right(words[index - 2], 19) ^ (words[index - 2] >> 10);
    words[index] = words[index - 16] + first + words[index - 7] + second;
  }
  uint32_t a = context->state[0], b = context->state[1];
  uint32_t c = context->state[2], d = context->state[3];
  uint32_t e = context->state[4], f = context->state[5];
  uint32_t g = context->state[6], h = context->state[7];
  for (size_t index = 0; index < 64; index++) {
    const uint32_t sum1 = rotate_right(e, 6) ^ rotate_right(e, 11)
      ^ rotate_right(e, 25);
    const uint32_t choice = (e & f) ^ ((~e) & g);
    const uint32_t first = h + sum1 + choice + sha256_constants[index]
      + words[index];
    const uint32_t sum0 = rotate_right(a, 2) ^ rotate_right(a, 13)
      ^ rotate_right(a, 22);
    const uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    const uint32_t second = sum0 + majority;
    h = g; g = f; f = e; e = d + first;
    d = c; c = b; b = a; a = first + second;
  }
  context->state[0] += a; context->state[1] += b;
  context->state[2] += c; context->state[3] += d;
  context->state[4] += e; context->state[5] += f;
  context->state[6] += g; context->state[7] += h;
}
static void sha256_initialize(struct sha256_context *context) {
  const uint32_t initial[8] = {
    0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
    0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U,
  };
  memcpy(context->state, initial, sizeof(initial));
  context->bit_count = 0; context->used = 0;
}
static void sha256_update(
  struct sha256_context *context,
  const unsigned char *bytes,
  size_t size
) {
  context->bit_count += (uint64_t)size * 8U;
  while (size > 0) {
    const size_t available = sizeof(context->block) - context->used;
    const size_t count = size < available ? size : available;
    memcpy(context->block + context->used, bytes, count);
    context->used += count; bytes += count; size -= count;
    if (context->used == sizeof(context->block)) {
      sha256_transform(context); context->used = 0;
    }
  }
}
static void sha256_finish(
  struct sha256_context *context,
  unsigned char digest[32]
) {
  const uint64_t bit_count = context->bit_count;
  context->block[context->used++] = 0x80;
  if (context->used > 56) {
    memset(context->block + context->used, 0, 64 - context->used);
    sha256_transform(context); context->used = 0;
  }
  memset(context->block + context->used, 0, 56 - context->used);
  for (size_t index = 0; index < 8; index++) {
    context->block[63 - index] = (unsigned char)(bit_count >> (index * 8));
  }
  sha256_transform(context);
  for (size_t index = 0; index < 8; index++) {
    digest[index * 4] = (unsigned char)(context->state[index] >> 24);
    digest[index * 4 + 1] = (unsigned char)(context->state[index] >> 16);
    digest[index * 4 + 2] = (unsigned char)(context->state[index] >> 8);
    digest[index * 4 + 3] = (unsigned char)context->state[index];
  }
}
static int parse_sha256(const char *raw, unsigned char digest[32]) {
  if (!raw || strlen(raw) != 64) return 0;
  for (size_t index = 0; index < 32; index++) {
    unsigned int value = 0;
    if (sscanf(raw + (index * 2), "%2x", &value) != 1) return 0;
    const char first = raw[index * 2], second = raw[index * 2 + 1];
    if (!((first >= '0' && first <= '9') || (first >= 'a' && first <= 'f'))
      || !((second >= '0' && second <= '9') || (second >= 'a' && second <= 'f'))) return 0;
    digest[index] = (unsigned char)value;
  }
  return 1;
}

static void stop_handler(int value) { (void)value; stop_requested = 1; }
static void stop_pending_handler(int value) { (void)value; stop_pending_requested = 1; }
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
static int same_file_metadata(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino
    && left->st_uid == right->st_uid && left->st_size == right->st_size
    && left->st_mode == right->st_mode
    && left->st_mtim.tv_sec == right->st_mtim.tv_sec
    && left->st_mtim.tv_nsec == right->st_mtim.tv_nsec
    && left->st_ctim.tv_sec == right->st_ctim.tv_sec
    && left->st_ctim.tv_nsec == right->st_ctim.tv_nsec;
}
static int create_candidate_memfd(void) {
  int descriptor = (int)syscall(
    SYS_memfd_create,
    "inertia-app-update-candidate",
    MFD_CLOEXEC | MFD_ALLOW_SEALING | MFD_EXEC
  );
  if (descriptor < 0 && errno == EINVAL) descriptor = (int)syscall(
    SYS_memfd_create,
    "inertia-app-update-candidate",
    MFD_CLOEXEC | MFD_ALLOW_SEALING
  );
  return descriptor;
}
static int seal_candidate_execution_file(
  int source_fd,
  const unsigned char expected_digest[32]
) {
  struct stat before, after, sealed;
  if (fstat(source_fd, &before) || before.st_size <= 0) return 0;
  int descriptor = create_candidate_memfd();
  if (descriptor < 0) return 0;
  int valid = fchmod(descriptor, before.st_mode & 0777) == 0;
  struct sha256_context digest_context; unsigned char digest[32];
  sha256_initialize(&digest_context);
  char buffer[1024 * 1024]; off_t position = 0;
  while (valid && position < before.st_size) {
    if (stop_pending_requested || stop_requested) {
      valid = 0;
      break;
    }
    size_t requested = sizeof(buffer);
    if (before.st_size - position < (off_t)requested) {
      requested = (size_t)(before.st_size - position);
    }
    ssize_t read_size;
    do { read_size = pread(source_fd, buffer, requested, position); }
    while (read_size < 0 && errno == EINTR);
    if (read_size <= 0) { valid = 0; break; }
    sha256_update(
      &digest_context,
      (const unsigned char *)buffer,
      (size_t)read_size
    );
#if defined(INERTIA_RUNTIME_GUARDIAN_TEST_SLOW_CANDIDATE_COPY)
    const struct timespec copy_pause = { .tv_sec = 0, .tv_nsec = 150000000L };
    nanosleep(&copy_pause, NULL);
#endif
    ssize_t written = 0;
    while (written < read_size) {
      ssize_t write_size = write(
        descriptor,
        buffer + written,
        (size_t)(read_size - written)
      );
      if (write_size < 0 && errno == EINTR) continue;
      if (write_size <= 0) { valid = 0; break; }
      written += write_size;
    }
    position += read_size;
  }
  if (valid) valid = fstat(source_fd, &after) == 0
    && same_file_metadata(&before, &after)
    && fstat(descriptor, &sealed) == 0
    && sealed.st_size == before.st_size
    && (sealed.st_mode & 0777) == (before.st_mode & 0777);
  if (valid) {
    sha256_finish(&digest_context, digest);
    valid = memcmp(digest, expected_digest, sizeof(digest)) == 0;
  }
  const int base_seals = F_SEAL_SEAL | F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_WRITE;
  if (valid && fcntl(descriptor, F_ADD_SEALS, base_seals | F_SEAL_EXEC)) {
    valid = errno == EINVAL && fcntl(descriptor, F_ADD_SEALS, base_seals) == 0;
  }
  int executable_descriptor = -1;
  if (valid) {
    char path[64];
    const int size = snprintf(path, sizeof(path), "/proc/self/fd/%d", descriptor);
    if (size <= 0 || size >= (int)sizeof(path)) valid = 0;
    else executable_descriptor = (int)syscall(
      SYS_openat,
      AT_FDCWD,
      path,
      O_RDONLY | O_CLOEXEC,
      0
    );
    if (executable_descriptor < 0) valid = 0;
  }
  if (valid) valid = dup2(executable_descriptor, source_fd) == source_fd;
  if (executable_descriptor >= 0) close(executable_descriptor);
  close(descriptor);
  return valid;
}
static int open_exact(const char *path, int flags) {
  return (int)syscall(SYS_openat, AT_FDCWD, path, flags, 0);
}
static int read_identity(pid_t pid, pid_t *parent_pid, unsigned long long *start) {
  char path[64], data[4096]; snprintf(path, sizeof(path), "/proc/%d/stat", pid);
  int fd = open_exact(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW); if (fd < 0) return 0;
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
  int sender_exe = open_exact(sender_path, O_PATH | O_CLOEXEC);
  int self_exe = open_exact("/proc/self/exe", O_PATH | O_CLOEXEC); struct stat left, right;
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
static int pidfd_exited(int pidfd) {
  struct pollfd descriptor = { .fd = pidfd, .events = POLLIN, .revents = 0 };
  int result;
  do { result = poll(&descriptor, 1, 0); } while (result < 0 && errno == EINTR);
  return result == 1 && (descriptor.revents & (POLLIN | POLLHUP));
}
static int exact_process_group_absent(pid_t pid) {
  errno = 0;
  if (kill(-pid, 0) == 0) return 0;
  return errno == ESRCH ? 1 : -1;
}
static void close_children(struct child *children, int count) {
  for (int index = 0; index < count; index++) close(children[index].pidfd);
}
static int census(struct child *children, int *count) {
  char path[96], data[8192];
  snprintf(path, sizeof(path), "/proc/self/task/%d/children", getpid());
  int fd = open_exact(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW); if (fd < 0) return 0;
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
#if defined(INERTIA_RUNTIME_GUARDIAN_TEST_REJECT_DRAIN)
  return 0;
#endif
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
  const char *terminal_name = clean
    ? (authorized ? "inertia-exdone" : "inertia-done")
    : "inertia-bad";
  (void)prctl(PR_SET_NAME, terminal_name, 0, 0, 0);
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
      (void)prctl(PR_SET_NAME, authorized ? "inertia-exitok" : "inertia-exit", 0, 0, 0);
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
  int fd = open_exact(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW); if (fd < 0) return 0;
  ssize_t size = read(fd, data, sizeof(data) - 1); close(fd);
  if (size <= 0 || size >= (ssize_t)sizeof(data)) return 0;
  data[size] = 0;
  return strstr(data, "Name:\tinertia-ready\n") && strstr(data, "TracerPid:\t0\n")
    && strstr(data, "Threads:\t1\n") && strstr(data, "NoNewPrivs:\t1\n");
}
static int named_status(pid_t pid, const char *name) {
  char path[64], data[4096], expected[64]; snprintf(path, sizeof(path), "/proc/%d/status", pid);
  int fd = open_exact(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW); if (fd < 0) return 0;
  ssize_t size = read(fd, data, sizeof(data) - 1); close(fd);
  if (size <= 0 || size >= (ssize_t)sizeof(data)) return 0;
  data[size] = 0; snprintf(expected, sizeof(expected), "Name:\t%s\n", name);
  return strstr(data, expected) != NULL;
}
static int hardened_terminal_status(pid_t pid) {
  char status_path[64], status[4096], children_path[96], children[32];
  snprintf(status_path, sizeof(status_path), "/proc/%d/status", pid);
  int status_fd = open_exact(status_path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (status_fd < 0) return 0;
  ssize_t status_size = read(status_fd, status, sizeof(status) - 1);
  close(status_fd);
  if (status_size <= 0 || status_size >= (ssize_t)sizeof(status)) return 0;
  status[status_size] = 0;
  if ((!strstr(status, "Name:\tinertia-done\n")
      && !strstr(status, "Name:\tinertia-exdone\n"))
    || !strstr(status, "State:\tT")
    || !strstr(status, "TracerPid:\t0\n")
    || !strstr(status, "Threads:\t1\n")
    || !strstr(status, "NoNewPrivs:\t1\n")
    || !strstr(status, "Seccomp:\t2\n")) return 0;
  const char *filters = strstr(status, "Seccomp_filters:\t");
  if (filters) {
    unsigned long long filter_count = 0;
    if (sscanf(filters, "Seccomp_filters:\t%llu", &filter_count) != 1
      || filter_count < 1) return 0;
  }
  snprintf(children_path, sizeof(children_path), "/proc/%d/task/%d/children", pid, pid);
  int children_fd = open_exact(children_path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (children_fd < 0) return 0;
  ssize_t children_size = read(children_fd, children, sizeof(children));
  close(children_fd);
  return children_size == 0;
}
static int recover_terminal_mode(int argc, char **argv) {
  if (argc != 8) return 64;
  pid_t pid;
  unsigned long long start, prior_device, prior_inode, helper_device, helper_inode;
  if (!parse_pid(argv[2], &pid) || !parse_u64(argv[3], &start)
    || !parse_u64(argv[4], &prior_device) || !parse_u64(argv[5], &prior_inode)
    || !parse_u64(argv[6], &helper_device) || !parse_u64(argv[7], &helper_inode)) return 64;
  // The prior executable identity is durable evidence that this was an
  // admitted guardian. It need not match the current packaged helper after an
  // update, but it must remain present and well-formed in the recovery claim.
  (void)prior_device;
  (void)prior_inode;
  struct stat helper;
  if (stat("/proc/self/exe", &helper)
    || (unsigned long long)helper.st_dev != helper_device
    || (unsigned long long)helper.st_ino != helper_inode) return 3;
  int pidfd = pidfd_open_exact(pid);
  if (pidfd < 0) return 3;
  const int valid = same_process(pid, start)
    && getpgid(pid) == pid
    && getsid(pid) == pid
    && hardened_terminal_status(pid);
  if (!valid || !same_process(pid, start)
    || syscall(SYS_pidfd_send_signal, pidfd, SIGKILL, NULL, 0)) {
    close(pidfd);
    return 3;
  }
  close(pidfd);
  return 0;
}
static int ready_mode(const char *raw) {
#if defined(INERTIA_RUNTIME_GUARDIAN_TEST_REJECT_READY)
  (void)raw;
  return 4;
#else
  pid_t pid; if (!parse_pid(raw, &pid)) return 64;
  struct timespec pause = { .tv_sec = 0, .tv_nsec = POLL_NS };
  for (int poll = 0; poll < 50; poll++) {
    if (getpgid(pid) == pid && getsid(pid) == pid && hardened_status(pid)) return identity_mode(raw);
    nanosleep(&pause, NULL);
  }
  return 4;
#endif
}
static int stop_pending_mode(int argc, char **argv) {
  if (argc != 6) return 64;
  pid_t pid, parent; unsigned long long helper_device, helper_inode;
  if (!parse_pid(argv[2], &pid) || !parse_pid(argv[3], &parent)
    || !parse_u64(argv[4], &helper_device) || !parse_u64(argv[5], &helper_inode)) return 64;
  struct stat self_executable;
  if (stat("/proc/self/exe", &self_executable)
    || (unsigned long long)self_executable.st_dev != helper_device
    || (unsigned long long)self_executable.st_ino != helper_inode) return 3;
  int pidfd = pidfd_open_exact(pid); if (pidfd < 0) return 3;
  pid_t observed_parent = 0; unsigned long long start = 0;
  if (!read_identity(pid, &observed_parent, &start) || observed_parent != parent) {
    close(pidfd); return 3;
  }
  struct timespec pause = { .tv_sec = 0, .tv_nsec = POLL_NS };
  for (int poll = 0; poll < 50; poll++) {
    pid_t confirmed_parent = 0; unsigned long long confirmed_start = 0;
    if (!read_identity(pid, &confirmed_parent, &confirmed_start)
      || confirmed_parent != parent || confirmed_start != start) {
      close(pidfd); return 3;
    }
    if (getpgid(pid) == pid && getsid(pid) == pid && hardened_status(pid)) {
      if (syscall(SYS_pidfd_send_signal, pidfd, SIGQUIT, NULL, 0)) {
        close(pidfd); return 3;
      }
      break;
    }
    if (poll == 49) { close(pidfd); return 4; }
    nanosleep(&pause, NULL);
  }
  for (int poll = 0; poll < 50; poll++) {
    pid_t confirmed_parent = 0; unsigned long long confirmed_start = 0;
    if (pidfd_exited(pidfd)) {
      const int group_absent = exact_process_group_absent(pid);
      if (group_absent != 0) { close(pidfd); return group_absent > 0 ? 0 : 3; }
      nanosleep(&pause, NULL); continue;
    }
    if (!read_identity(pid, &confirmed_parent, &confirmed_start)) {
      if (!pidfd_exited(pidfd)) { close(pidfd); return 3; }
      const int group_absent = exact_process_group_absent(pid);
      if (group_absent != 0) { close(pidfd); return group_absent > 0 ? 0 : 3; }
      nanosleep(&pause, NULL); continue;
    }
    if (confirmed_parent != parent || confirmed_start != start) {
      close(pidfd); return 3;
    }
    if (getpgid(pid) != pid || getsid(pid) != pid) {
      close(pidfd); return 3;
    }
    if (!named_status(pid, "inertia-ready")) {
      close(pidfd); return 3;
    }
    nanosleep(&pause, NULL);
  }
  if (pidfd_exited(pidfd) && exact_process_group_absent(pid) == 1) {
    close(pidfd); return 0;
  }
  close(pidfd); return 4;
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
  else if (!strcmp(action, "release")) { first_signal = SIGUSR2; second_signal = SIGCONT; }
  else if (!strcmp(action, "detach")) { expected_name = "inertia-owned"; first_signal = SIGUSR1; }
  else if (!strcmp(action, "kill")) { first_signal = SIGKILL; }
  else if (!strcmp(action, "stop")) { first_signal = SIGTERM; }
  else return 64;
  int pidfd = pidfd_open_exact(pid); if (pidfd < 0) return 3;
  const int expected_state = expected_name ? named_status(pid, expected_name)
    : (!strcmp(action, "release") || !strcmp(action, "kill"))
      ? (named_status(pid, "inertia-done") || named_status(pid, "inertia-exdone"))
      : (named_status(pid, "inertia-ready") || named_status(pid, "inertia-claim")
        || named_status(pid, "inertia-owned"));
  if (!same_process(pid, start) || !expected_state) {
    close(pidfd);
    return 3;
  }
  const int valid_state = expected_name ? named_status(pid, expected_name)
    : (!strcmp(action, "release") || !strcmp(action, "kill"))
      ? (named_status(pid, "inertia-done") || named_status(pid, "inertia-exdone"))
      : (named_status(pid, "inertia-ready") || named_status(pid, "inertia-claim")
        || named_status(pid, "inertia-owned"));
  const int valid = same_process(pid, start) && valid_state;
  if (!valid || syscall(SYS_pidfd_send_signal, pidfd, first_signal, NULL, 0)
    || (second_signal && syscall(SYS_pidfd_send_signal, pidfd, second_signal, NULL, 0))) {
    close(pidfd); return 3;
  }
  if (!strcmp(action, "claim") || !strcmp(action, "exec")
    || !strcmp(action, "release") || !strcmp(action, "detach")) {
    const char *next_name = !strcmp(action, "claim") ? "inertia-claim"
      : (!strcmp(action, "exec") ? "inertia-owned" : "inertia-exit");
    struct timespec pause = { .tv_sec = 0, .tv_nsec = POLL_NS };
    for (int poll = 0; poll < 50; poll++) {
      if (!strcmp(action, "detach") && pidfd_exited(pidfd)) {
        close(pidfd); return 0;
      }
      if (named_status(pid, next_name)
        || (!strcmp(action, "exec")
          && (named_status(pid, "inertia-exdone") || named_status(pid, "inertia-exitok")))
        || (!strcmp(action, "release") && named_status(pid, "inertia-exitok"))) {
        close(pidfd); return 0;
      }
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
static int bind_selftest_child_to_parent(pid_t expected_parent) {
  return prctl(PR_SET_PDEATHSIG, SIGKILL) == 0 && getppid() == expected_parent;
}
static int seccomp_selftest(void) {
  const pid_t selftest_parent = getpid();
  const pid_t allowed = fork();
  if (allowed < 0) return 2;
  if (allowed == 0) {
    if (!bind_selftest_child_to_parent(selftest_parent)) _exit(3);
#if defined(INERTIA_RUNTIME_GUARDIAN_TEST_HANG_SECCOMP_CHILD)
#if defined(INERTIA_RUNTIME_GUARDIAN_TEST_CHILD_PID_FILE)
    int marker = open(INERTIA_RUNTIME_GUARDIAN_TEST_CHILD_PID_FILE,
      O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (marker >= 0) {
      char value[32]; const int size = snprintf(value, sizeof(value), "%d\n", (int)getpid());
      if (size > 0) {
        const ssize_t written = write(marker, value, (size_t)size);
        if (written != size) { close(marker); _exit(3); }
      }
      close(marker);
    }
#endif
    for (;;) pause();
#endif
    const pid_t pid = getpid(); const pid_t tid = (pid_t)syscall(SYS_gettid);
    unsigned long long start = 0;
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)
      || !install_terminal_filter(pid, tid)
      || !read_start(pid, &start)
      || start == 0) _exit(3);
    _exit(0);
  }
  int status = 0;
  if (waitpid(allowed, &status, 0) != allowed || !WIFEXITED(status) || WEXITSTATUS(status) != 0) {
    return 2;
  }
  const pid_t denied_fcntl = fork();
  if (denied_fcntl < 0) return 2;
  if (denied_fcntl == 0) {
    if (!bind_selftest_child_to_parent(selftest_parent)) _exit(3);
    const pid_t pid = getpid(); const pid_t tid = (pid_t)syscall(SYS_gettid);
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || !install_terminal_filter(pid, tid)) _exit(3);
    (void)fcntl(STDIN_FILENO, F_GETFD);
    _exit(4);
  }
  status = 0;
  if (waitpid(denied_fcntl, &status, 0) != denied_fcntl
    || !WIFSIGNALED(status) || WTERMSIG(status) != SIGSYS) return 2;
  const pid_t denied_flag = fork();
  if (denied_flag < 0) return 2;
  if (denied_flag == 0) {
    if (!bind_selftest_child_to_parent(selftest_parent)) _exit(3);
    const pid_t pid = getpid(); const pid_t tid = (pid_t)syscall(SYS_gettid);
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || !install_terminal_filter(pid, tid)) _exit(3);
    (void)fcntl(STDIN_FILENO, F_SETFD, 0);
    _exit(4);
  }
  status = 0;
  if (waitpid(denied_flag, &status, 0) != denied_flag
    || !WIFSIGNALED(status) || WTERMSIG(status) != SIGSYS) return 2;
  const pid_t denied_syscall = fork();
  if (denied_syscall < 0) return 2;
  if (denied_syscall == 0) {
    if (!bind_selftest_child_to_parent(selftest_parent)) _exit(3);
    const pid_t pid = getpid(); const pid_t tid = (pid_t)syscall(SYS_gettid);
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || !install_terminal_filter(pid, tid)) _exit(3);
    (void)syscall(SYS_getuid);
    _exit(4);
  }
  status = 0;
  if (waitpid(denied_syscall, &status, 0) != denied_syscall) return 2;
  return WIFSIGNALED(status) && WTERMSIG(status) == SIGSYS ? 0 : 1;
}
static int seccomp_selftest_identity_mode(void) {
  const int result = seccomp_selftest();
  if (result != 0) return result;
  char self[32]; snprintf(self, sizeof(self), "%d", (int)getpid());
  return identity_mode(self);
}
static int watch_mode(int argc, char **argv, int handoff) {
  const int separator = handoff ? 8 : 5;
  const int payload_argument = separator + 1;
  if (argc <= payload_argument || strcmp(argv[separator], "--")
    || (handoff && strcmp(argv[9], "/proc/self/fd/4"))) return 64;
  pid_t parent; unsigned long long parent_start = 0;
  unsigned long long expected_device = 0, expected_inode = 0; struct stat self_executable;
  unsigned char candidate_digest[32] = {0};
  if (!parse_pid(argv[2], &parent) || !read_start(parent, &parent_start)
    || !parse_u64(argv[3], &expected_device) || !parse_u64(argv[4], &expected_inode)
    || stat("/proc/self/exe", &self_executable)
    || (unsigned long long)self_executable.st_dev != expected_device
    || (unsigned long long)self_executable.st_ino != expected_inode) return 69;
  if (handoff) {
    unsigned long long candidate_device = 0, candidate_inode = 0;
    struct stat candidate;
    if (!parse_u64(argv[5], &candidate_device)
      || !parse_u64(argv[6], &candidate_inode)
      || !parse_sha256(argv[7], candidate_digest)
      || fstat(4, &candidate)
      || !S_ISREG(candidate.st_mode)
      || candidate.st_uid != getuid()
      || !(candidate.st_mode & S_IXUSR)
      || (unsigned long long)candidate.st_dev != candidate_device
      || (unsigned long long)candidate.st_ino != candidate_inode) return 69;
  }
  if ((getsid(0) != getpid() && (getpgrp() == getpid() || setsid() != getpid()))
    || getsid(0) != getpid() || getpgrp() != getpid()
    || prctl(PR_SET_CHILD_SUBREAPER, 1) || prctl(PR_SET_DUMPABLE, 0)
    || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) return 70;
  struct sigaction stop = {0}, claim = {0}, authorize = {0};
  stop.sa_handler = stop_handler; claim.sa_sigaction = claim_handler; claim.sa_flags = SA_SIGINFO;
  authorize.sa_sigaction = authorize_handler; authorize.sa_flags = SA_SIGINFO;
  sigemptyset(&stop.sa_mask); sigemptyset(&claim.sa_mask); sigemptyset(&authorize.sa_mask);
  runtime_pid = parent; runtime_start = parent_start;
  struct sigaction stop_pending = {0}; stop_pending.sa_handler = stop_pending_handler;
  sigemptyset(&stop_pending.sa_mask);
  if (sigaction(SIGTERM, &stop, NULL) || sigaction(SIGINT, &stop, NULL) || sigaction(SIGHUP, &stop, NULL)
    || sigaction(SIGQUIT, &stop_pending, NULL)
    || sigaction(SIGUSR1, &claim, NULL) || sigaction(SIGUSR2, &authorize, NULL)) return 70;
  if (handoff) {
    struct stat ready_channel;
    if (prctl(PR_SET_NAME, "inertia-ready", 0, 0, 0)
      || fstat(5, &ready_channel)
      || (!S_ISFIFO(ready_channel.st_mode) && !S_ISSOCK(ready_channel.st_mode))
      || !seal_candidate_execution_file(4, candidate_digest)) {
      close(5);
      return (stop_pending_requested || stop_requested) ? 143 : 69;
    }
  }
  int gate[2]; if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, gate)) return 70;
  pid_t payload = fork(); if (payload < 0) return 70;
  if (payload == 0) {
    if (handoff) close(5);
    close(gate[1]); char byte = 0; ssize_t size;
    do { size = read(gate[0], &byte, 1); } while (size < 0 && errno == EINTR);
    close(gate[0]);
    if (size != 1 || byte != 'A') {
#if defined(INERTIA_RUNTIME_GUARDIAN_TEST_HOLD_GATE_FAILURE)
      for (;;) pause();
#else
      _exit(125);
#endif
    }
    execvp(argv[payload_argument], &argv[payload_argument]); _exit(127);
  }
  struct child preflight_children[MAX_CHILDREN]; int preflight_count = 0;
  if (census(preflight_children, &preflight_count) != 1
    || preflight_count != 1 || preflight_children[0].pid != payload
    || !pidfd_signal(preflight_children[0].pidfd, 0)) {
    close_children(preflight_children, preflight_count);
    close(gate[1]); (void)waitpid(payload, NULL, 0); return 70;
  }
  const unsigned long long payload_start = preflight_children[0].start;
  close_children(preflight_children, preflight_count);
  if (!handoff && prctl(PR_SET_NAME, "inertia-ready", 0, 0, 0)) return 70;
  if (handoff) {
    if (write(5, "R", 1) != 1) {
      close(5); close(gate[1]); return terminal_state(drain(), 127);
    }
    close(5);
  }
  // Keep the PTY slave alive until the guardian itself exits. A payload may
  // close all three standard descriptors before it becomes waitable; without
  // this private post-fork hold, EIO closes the master and causes SIGHUP.
  if (isatty(STDIN_FILENO)) {
    const int terminal_hold = fcntl(
      STDIN_FILENO,
      F_DUPFD_CLOEXEC,
      STDERR_FILENO + 1
    );
    if (terminal_hold < 0) {
      close(gate[0]); close(gate[1]); (void)waitpid(payload, NULL, 0); return 70;
    }
    (void)terminal_hold;
  }
  if (handoff) { close(3); close(4); }
  close(gate[0]); close(STDIN_FILENO); close(STDOUT_FILENO); close(STDERR_FILENO);
  struct timespec pause = { .tv_sec = 0, .tv_nsec = POLL_NS };
  while (!claimed) {
    if (claim_sender) {
      const pid_t sender = claim_sender; claim_sender = 0;
      if (trusted_runtime_helper(sender, parent, parent_start)) claimed = 1;
    }
    if (!same_process(parent, parent_start)) {
      close(gate[1]); return drain() ? 137 : 127;
    }
    if (stop_pending_requested) {
      close(gate[1]);
#if defined(INERTIA_RUNTIME_GUARDIAN_TEST_CRASH_STOP_PENDING)
      _exit(99);
#endif
      if (!drain()) return terminal_state(0, 127);
      return 143;
    }
    if (stop_requested) {
      close(gate[1]);
      if (handoff) return terminal_state(drain(), 143);
      return drain() ? 143 : 127;
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
    // A subreaper also owns orphaned descendants. Collect their exit status
    // while the payload stays live, but never lose the payload's own result.
    // Bound each pass so continuous churn cannot starve stop/parent checks.
    pid_t waited = 0;
    for (int reaped = 0; reaped < MAX_CHILDREN; reaped++) {
      waited = waitpid(-1, &status, WNOHANG);
      if (waited <= 0 || waited == payload) break;
    }
    if (waited == payload) {
      int result = WIFEXITED(status) ? WEXITSTATUS(status) : (WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 127);
      return terminal_state(drain(), result);
    }
    if (waited < 0 && errno != EINTR) return terminal_state(0, 127);
    if (!same_process(parent, parent_start)) return terminal_state(drain(), 137);
    if (stop_requested) return terminal_state(drain(), 143);
    if (handoff && claim_sender) {
      const pid_t sender = claim_sender; claim_sender = 0;
      pid_t payload_parent = 0; unsigned long long confirmed_start = 0;
      if (trusted_runtime_helper(sender, parent, parent_start)
        && read_identity(payload, &payload_parent, &confirmed_start)
        && payload_parent == getpid()
        && confirmed_start == payload_start) return 0;
    }
    nanosleep(&pause, NULL);
  }
}
int main(int argc, char **argv) {
  const struct rlimit no_core = { .rlim_cur = 0, .rlim_max = 0 };
  if (setrlimit(RLIMIT_CORE, &no_core)) return 70;
  if (argc == 2 && !strcmp(argv[1], "seccomp-selftest")) return seccomp_selftest();
  if (argc == 2 && !strcmp(argv[1], "seccomp-selftest-identity")) {
    return seccomp_selftest_identity_mode();
  }
  if (argc == 3 && !strcmp(argv[1], "identity")) return identity_mode(argv[2]);
  if (argc == 3 && !strcmp(argv[1], "ready")) return ready_mode(argv[2]);
  if (argc == 6 && !strcmp(argv[1], "stop-pending")) return stop_pending_mode(argc, argv);
  if (argc == 3 && !strcmp(argv[1], "claimed")) return state_mode(argv[2], "inertia-claim");
  if (argc == 3 && !strcmp(argv[1], "owned")) return state_mode(argv[2], "inertia-owned");
  if (argc >= 2 && !strcmp(argv[1], "recover-terminal")) return recover_terminal_mode(argc, argv);
  if (argc >= 2 && !strcmp(argv[1], "signal")) return exact_signal_mode(argc, argv);
  if (argc >= 5 && !strcmp(argv[1], "watch")) return watch_mode(argc, argv, 0);
  if (argc >= 8 && !strcmp(argv[1], "handoff")) return watch_mode(argc, argv, 1);
  return 64;
}
