#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

// Create descendants sequentially and acknowledge each only after adoption.
// The root waits for every intermediate child; only the guardian can reap the
// orphan. Live descendants use separate sessions, as real tool daemons do.
static int orphan(int live) {
  int ready[2];
  if (pipe(ready)) return 0;
  const pid_t intermediate = fork();
  if (intermediate < 0) return 0;
  if (intermediate == 0) {
    close(ready[0]);
    if (setsid() < 0) _exit(65);
    const pid_t original_parent = getpid();
    const pid_t descendant = fork();
    if (descendant < 0) _exit(66);
    if (descendant > 0) _exit(0);
    const struct timespec pause_time = { .tv_sec = 0, .tv_nsec = 1000000L };
    while (getppid() == original_parent) nanosleep(&pause_time, NULL);
    if (write(ready[1], "R", 1) != 1) _exit(67);
    close(ready[1]);
    if (live) for (;;) pause();
    _exit(91); // Must never replace the root's result.
  }
  close(ready[1]);
  char byte = 0;
  ssize_t size;
  do { size = read(ready[0], &byte, 1); } while (size < 0 && errno == EINTR);
  close(ready[0]);
  int status = 0;
  pid_t waited;
  do { waited = waitpid(intermediate, &status, 0); } while (waited < 0 && errno == EINTR);
  return size == 1 && byte == 'R' && waited == intermediate
    && WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

int main(int argc, char **argv) {
  if (argc != 6) return 64;
  const int short_lived = atoi(argv[3]), live = atoi(argv[4]);
  if (short_lived < 0 || short_lived > 1024 || live < 0 || live > 512) return 64;
  for (int index = 0; index < live; index++) if (!orphan(1)) return 68;
  for (int index = 0; index < short_lived; index++) if (!orphan(0)) return 69;
  const int descriptor = open(argv[1], O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (descriptor < 0) return 70;
  if (dprintf(descriptor, "%d\n", getpid()) < 0) return 71;
  close(descriptor);
  const struct timespec pause_time = { .tv_sec = 0, .tv_nsec = 20000000L };
  while (access(argv[2], F_OK)) nanosleep(&pause_time, NULL);
  if (!strcmp(argv[5], "signal")) { raise(SIGUSR1); return 72; }
  return atoi(argv[5]);
}
