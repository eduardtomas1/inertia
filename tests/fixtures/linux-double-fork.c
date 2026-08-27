#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <sys/types.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 2 && argc != 3) return 64;
  const pid_t first = fork();
  if (first < 0) return 65;
  if (first > 0) {
    if (argc == 3) for (;;) pause();
    return 0;
  }
  if (setsid() < 0) _exit(66);
  const pid_t second = fork();
  if (second < 0) _exit(67);
  if (second > 0) _exit(0);
  const int descriptor = open(argv[1], O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (descriptor < 0) _exit(68);
  (void)dprintf(descriptor, "%d\n", getpid());
  (void)close(descriptor);
  for (;;) pause();
}
