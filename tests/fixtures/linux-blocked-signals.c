#define _POSIX_C_SOURCE 200809L
#include <signal.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 2) return 64;
  sigset_t blocked;
  sigemptyset(&blocked);
  const int signals[] = { SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2, SIGWINCH };
  for (unsigned int i = 0; i < sizeof(signals) / sizeof(signals[0]); i++) {
    sigaddset(&blocked, signals[i]);
  }
  if (sigprocmask(SIG_BLOCK, &blocked, NULL)) return 70;
  execv(argv[1], &argv[1]);
  return 127;
}
