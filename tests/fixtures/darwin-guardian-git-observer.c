#include <sys/event.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
static int fixture_kevent(int, const struct kevent *, int, struct kevent *, int, const struct timespec *);
static int fixture_execvp(const char *, char *const []);
#define kevent(...) fixture_kevent(__VA_ARGS__)
#define execvp(...) fixture_execvp(__VA_ARGS__)
#define main included_guardian_main
#include "../../native/runtime-process-guardian/darwin.c"
#undef main
#undef execvp
#undef kevent
static int fixture_kevent(int queue, const struct kevent *changes, int nchanges, struct kevent *events, int nevents, const struct timespec *timeout) {
  const int result = kevent(queue, changes, nchanges, events, nevents, timeout);
  const int saved_errno = errno;
  for (int index = 0; index < result; index += 1) {
    if ((events[index].fflags & NOTE_FORK) != 0) (void)dprintf(2, "FIXTURE_NOTE_FORK\n");
    if ((events[index].flags & EV_ERROR) != 0) (void)dprintf(2, "FIXTURE_EVENT_ERROR\n");
  }
  errno = saved_errno;
  return result;
}
static int fixture_execvp(const char *file, char *const args[]) {
  (void)dprintf(2, "FIXTURE_EXEC_READY\n");
  return execvp(file, args);
}
int main(int argc, char **argv) { return included_guardian_main(argc, argv); }
