/*
** SQLite VFS for WASI (wasm32-wasip2) — di-framework:sqlite component.
**
** Derived from SQLite's public-domain ext/misc/demovfs.c (the same base as
** libsqlite3-sys' bundled `wasm32-wasi-vfs.c`). That copy predates several
** SQLite features and is not usable as-is:
**
**   * xFileControl returned SQLITE_OK for every opcode. Since SQLite 3.7.x
**     `PRAGMA` first sends SQLITE_FCNTL_PRAGMA to the VFS and, if the VFS
**     answers SQLITE_OK, assumes the VFS handled it and compiles a no-op —
**     so *every* PRAGMA (journal_mode, synchronous, user_version, ...) was
**     silently ignored. We return SQLITE_NOTFOUND.
**   * xTruncate was a no-op, which makes any journal mode other than DELETE
**     unsafe and prevents VACUUM/auto_vacuum from shrinking the file. We call
**     ftruncate() (wasi: fd_filestat_set_size).
**   * xRandomness returned no entropy. We use getentropy() (wasi: random_get).
**   * xDelete's directory-name scan ran forwards past the end of the buffer.
**   * lseek()+read()/write() replaced by pread()/pwrite().
**
** Deliberate limitations (same as demovfs, documented in the README):
**
**   * No file locking: xLock/xUnlock are no-ops. WASI has no advisory locks.
**     Exactly one connection per database file per component instance, and
**     exactly one component instance per file on the host.
**   * No shared memory, hence no WAL. sqlite3.c is compiled with
**     -DSQLITE_OMIT_WAL so `PRAGMA journal_mode=WAL` is a no-op.
**   * No temp files (xOpen with zName==NULL fails). sqlite3.c is compiled with
**     -DSQLITE_TEMP_STORE=3 and -DSQLITE_STMTJRNL_SPILL=-1 so SQLite never
**     asks for one.
**   * Journal writes are buffered (WASI_VFS_JOURNAL_BUFSZ) and flushed on
**     read/sync/size/close, exactly as demovfs does; this keeps the number of
**     host fd_write calls per commit small.
*/
#include "sqlite3.h"

#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#ifndef WASI_VFS_JOURNAL_BUFSZ
#define WASI_VFS_JOURNAL_BUFSZ 8192
#endif
#define WASI_VFS_MAXPATH 512
#define WASI_VFS_NAME "wasi"

typedef struct WasiFile WasiFile;
struct WasiFile {
  sqlite3_file base;          /* Base class. Must be first. */
  int fd;                     /* File descriptor */
  char *aBuffer;              /* Journal write buffer, or NULL */
  int nBuffer;                /* Valid bytes in aBuffer */
  sqlite3_int64 iBufferOfst;  /* File offset of aBuffer[0] */
};

/* Write exactly n bytes at offset ofst, retrying on short writes. */
static int wasiPwriteAll(int fd, const void *buf, int n, sqlite3_int64 ofst) {
  const char *z = (const char *)buf;
  while (n > 0) {
    ssize_t w = pwrite(fd, z, (size_t)n, (off_t)ofst);
    if (w < 0) {
      if (errno == EINTR) continue;
      return SQLITE_IOERR_WRITE;
    }
    if (w == 0) return SQLITE_FULL;
    z += w;
    n -= (int)w;
    ofst += w;
  }
  return SQLITE_OK;
}

static int wasiFlushBuffer(WasiFile *p) {
  int rc = SQLITE_OK;
  if (p->nBuffer) {
    rc = wasiPwriteAll(p->fd, p->aBuffer, p->nBuffer, p->iBufferOfst);
    p->nBuffer = 0;
  }
  return rc;
}

static int wasiClose(sqlite3_file *pFile) {
  WasiFile *p = (WasiFile *)pFile;
  int rc = wasiFlushBuffer(p);
  sqlite3_free(p->aBuffer);
  p->aBuffer = 0;
  if (p->fd >= 0) close(p->fd);
  p->fd = -1;
  return rc;
}

static int wasiRead(sqlite3_file *pFile, void *zBuf, int iAmt, sqlite3_int64 iOfst) {
  WasiFile *p = (WasiFile *)pFile;
  char *z = (char *)zBuf;
  int got = 0;

  /* The buffer may hold data for the region being read. */
  int rc = wasiFlushBuffer(p);
  if (rc != SQLITE_OK) return rc;

  while (got < iAmt) {
    ssize_t r = pread(p->fd, z + got, (size_t)(iAmt - got), (off_t)(iOfst + got));
    if (r < 0) {
      if (errno == EINTR) continue;
      return SQLITE_IOERR_READ;
    }
    if (r == 0) break; /* EOF */
    got += (int)r;
  }
  if (got == iAmt) return SQLITE_OK;
  /* Short read: zero-fill the remainder, as SQLite requires. */
  memset(z + got, 0, (size_t)(iAmt - got));
  return SQLITE_IOERR_SHORT_READ;
}

static int wasiWrite(sqlite3_file *pFile, const void *zBuf, int iAmt, sqlite3_int64 iOfst) {
  WasiFile *p = (WasiFile *)pFile;

  if (p->aBuffer) {
    const char *z = (const char *)zBuf;
    int n = iAmt;
    sqlite3_int64 i = iOfst;

    while (n > 0) {
      int nCopy;
      /* Flush if the buffer is full or this write is not contiguous. */
      if (p->nBuffer == WASI_VFS_JOURNAL_BUFSZ || p->iBufferOfst + p->nBuffer != i) {
        int rc = wasiFlushBuffer(p);
        if (rc != SQLITE_OK) return rc;
      }
      p->iBufferOfst = i - p->nBuffer;

      nCopy = WASI_VFS_JOURNAL_BUFSZ - p->nBuffer;
      if (nCopy > n) nCopy = n;
      memcpy(&p->aBuffer[p->nBuffer], z, (size_t)nCopy);
      p->nBuffer += nCopy;

      n -= nCopy;
      i += nCopy;
      z += nCopy;
    }
    return SQLITE_OK;
  }
  return wasiPwriteAll(p->fd, zBuf, iAmt, iOfst);
}

static int wasiTruncate(sqlite3_file *pFile, sqlite3_int64 size) {
  WasiFile *p = (WasiFile *)pFile;
  int rc = wasiFlushBuffer(p);
  if (rc != SQLITE_OK) return rc;
  if (ftruncate(p->fd, (off_t)size) != 0) return SQLITE_IOERR_TRUNCATE;
  return SQLITE_OK;
}

static int wasiSync(sqlite3_file *pFile, int flags) {
  WasiFile *p = (WasiFile *)pFile;
  int rc = wasiFlushBuffer(p);
  (void)flags;
  if (rc != SQLITE_OK) return rc;
  /* wasi:filesystem `sync` = fsync; there is no cheaper fdatasync on WASI. */
  return fsync(p->fd) == 0 ? SQLITE_OK : SQLITE_IOERR_FSYNC;
}

static int wasiFileSize(sqlite3_file *pFile, sqlite3_int64 *pSize) {
  WasiFile *p = (WasiFile *)pFile;
  struct stat st;
  int rc = wasiFlushBuffer(p);
  if (rc != SQLITE_OK) return rc;
  if (fstat(p->fd, &st) != 0) return SQLITE_IOERR_FSTAT;
  *pSize = (sqlite3_int64)st.st_size;
  return SQLITE_OK;
}

/* No advisory locks on WASI. Single-writer is enforced by the deployment. */
static int wasiLock(sqlite3_file *pFile, int eLock) {
  (void)pFile; (void)eLock;
  return SQLITE_OK;
}
static int wasiUnlock(sqlite3_file *pFile, int eLock) {
  (void)pFile; (void)eLock;
  return SQLITE_OK;
}
static int wasiCheckReservedLock(sqlite3_file *pFile, int *pResOut) {
  (void)pFile;
  *pResOut = 0;
  return SQLITE_OK;
}

/* Must be SQLITE_NOTFOUND for unknown opcodes, otherwise PRAGMA breaks. */
static int wasiFileControl(sqlite3_file *pFile, int op, void *pArg) {
  (void)pFile;
  if (op == SQLITE_FCNTL_VFSNAME) {
    *(char **)pArg = sqlite3_mprintf("%s", WASI_VFS_NAME);
    return SQLITE_OK;
  }
  return SQLITE_NOTFOUND;
}

static int wasiSectorSize(sqlite3_file *pFile) {
  (void)pFile;
  return 0; /* SQLite substitutes its default (4096). */
}

static int wasiDeviceCharacteristics(sqlite3_file *pFile) {
  (void)pFile;
  return 0;
}

static int wasiOpen(sqlite3_vfs *pVfs, const char *zName, sqlite3_file *pFile, int flags,
                    int *pOutFlags) {
  static const sqlite3_io_methods wasiio = {
      1,                        /* iVersion */
      wasiClose,                /* xClose */
      wasiRead,                 /* xRead */
      wasiWrite,                /* xWrite */
      wasiTruncate,             /* xTruncate */
      wasiSync,                 /* xSync */
      wasiFileSize,             /* xFileSize */
      wasiLock,                 /* xLock */
      wasiUnlock,               /* xUnlock */
      wasiCheckReservedLock,    /* xCheckReservedLock */
      wasiFileControl,          /* xFileControl */
      wasiSectorSize,           /* xSectorSize */
      wasiDeviceCharacteristics,/* xDeviceCharacteristics */
      0, 0, 0, 0,               /* v2: xShmMap, xShmLock, xShmBarrier, xShmUnmap (no WAL) */
      0, 0                      /* v3: xFetch, xUnfetch (no mmap) */
  };

  WasiFile *p = (WasiFile *)pFile;
  int oflags = 0;
  char *aBuf = 0;
  (void)pVfs;

  memset(p, 0, sizeof(WasiFile));
  p->fd = -1;

  /* Anonymous temp files are not supported; see the header comment. */
  if (zName == 0) return SQLITE_CANTOPEN;

  if (flags & SQLITE_OPEN_MAIN_JOURNAL) {
    aBuf = (char *)sqlite3_malloc(WASI_VFS_JOURNAL_BUFSZ);
    if (!aBuf) return SQLITE_NOMEM;
  }

  if (flags & SQLITE_OPEN_EXCLUSIVE) oflags |= O_EXCL;
  if (flags & SQLITE_OPEN_CREATE) oflags |= O_CREAT;
  if (flags & SQLITE_OPEN_READONLY) oflags |= O_RDONLY;
  if (flags & SQLITE_OPEN_READWRITE) oflags |= O_RDWR;

  p->fd = open(zName, oflags, 0600);
  if (p->fd < 0) {
    sqlite3_free(aBuf);
    /* Opening read-write may fail on a read-only preopen; SQLite retries
    ** read-only when we report it, so tell it. */
    if ((flags & SQLITE_OPEN_READWRITE) && (errno == EACCES || errno == EROFS || errno == EPERM)) {
      return SQLITE_READONLY;
    }
    return SQLITE_CANTOPEN;
  }
  p->aBuffer = aBuf;

  if (pOutFlags) *pOutFlags = flags;
  p->base.pMethods = &wasiio;
  return SQLITE_OK;
}

static int wasiDelete(sqlite3_vfs *pVfs, const char *zPath, int dirSync) {
  int rc;
  (void)pVfs;

  rc = unlink(zPath);
  if (rc != 0 && errno == ENOENT) return SQLITE_OK;
  if (rc != 0) return SQLITE_IOERR_DELETE;

  if (dirSync) {
    /* Best effort: sync the containing directory so the unlink is durable.
    ** Failure to open/sync the directory is not an error (some hosts do not
    ** allow fsync on directory handles). */
    char zDir[WASI_VFS_MAXPATH + 1];
    size_t n = strlen(zPath);
    if (n > WASI_VFS_MAXPATH) n = WASI_VFS_MAXPATH;
    memcpy(zDir, zPath, n);
    zDir[n] = '\0';
    while (n > 1 && zDir[n - 1] != '/') n--;
    if (n > 1) n--; /* drop the trailing slash unless the dir is "/" */
    zDir[n] = '\0';
    if (n > 0) {
      int dfd = open(zDir, O_RDONLY | O_DIRECTORY, 0);
      if (dfd >= 0) {
        (void)fsync(dfd);
        close(dfd);
      }
    }
  }
  return SQLITE_OK;
}

static int wasiAccess(sqlite3_vfs *pVfs, const char *zPath, int flags, int *pResOut) {
  int eAccess = F_OK;
  (void)pVfs;
  if (flags == SQLITE_ACCESS_READWRITE) eAccess = R_OK | W_OK;
  if (flags == SQLITE_ACCESS_READ) eAccess = R_OK;
  *pResOut = (access(zPath, eAccess) == 0);
  return SQLITE_OK;
}

/* Paths are guest paths inside a WASI preopen; absolute paths pass through.
** Relative paths are left alone: wasi-libc resolves them against a "."
** preopen if the host provided one. */
static int wasiFullPathname(sqlite3_vfs *pVfs, const char *zPath, int nPathOut, char *zPathOut) {
  (void)pVfs;
  sqlite3_snprintf(nPathOut, zPathOut, "%s", zPath);
  zPathOut[nPathOut - 1] = '\0';
  return SQLITE_OK;
}

/* Loadable extensions: not available inside a component. */
static void *wasiDlOpen(sqlite3_vfs *pVfs, const char *zPath) {
  (void)pVfs; (void)zPath;
  return 0;
}
static void wasiDlError(sqlite3_vfs *pVfs, int nByte, char *zErrMsg) {
  (void)pVfs;
  sqlite3_snprintf(nByte, zErrMsg, "loadable extensions are not supported");
  zErrMsg[nByte - 1] = '\0';
}
static void (*wasiDlSym(sqlite3_vfs *pVfs, void *pH, const char *z))(void) {
  (void)pVfs; (void)pH; (void)z;
  return 0;
}
static void wasiDlClose(sqlite3_vfs *pVfs, void *pHandle) {
  (void)pVfs; (void)pHandle;
}

/* getentropy() caps each request at 256 bytes. */
static int wasiRandomness(sqlite3_vfs *pVfs, int nByte, char *zByte) {
  int got = 0;
  (void)pVfs;
  while (got < nByte) {
    int chunk = nByte - got;
    if (chunk > 256) chunk = 256;
    if (getentropy(zByte + got, (size_t)chunk) != 0) break;
    got += chunk;
  }
  return got;
}

static int wasiSleep(sqlite3_vfs *pVfs, int nMicro) {
  struct timespec ts;
  (void)pVfs;
  ts.tv_sec = nMicro / 1000000;
  ts.tv_nsec = (long)(nMicro % 1000000) * 1000;
  nanosleep(&ts, 0);
  return nMicro;
}

/* Milliseconds since the Julian epoch (noon, 24 Nov 4714 BC proleptic Gregorian). */
static int wasiCurrentTimeInt64(sqlite3_vfs *pVfs, sqlite3_int64 *piNow) {
  static const sqlite3_int64 unixEpoch = 24405875 * (sqlite3_int64)8640000;
  struct timespec ts;
  (void)pVfs;
  if (clock_gettime(CLOCK_REALTIME, &ts) != 0) return SQLITE_ERROR;
  *piNow = unixEpoch + 1000 * (sqlite3_int64)ts.tv_sec + ts.tv_nsec / 1000000;
  return SQLITE_OK;
}

static int wasiCurrentTime(sqlite3_vfs *pVfs, double *pTime) {
  sqlite3_int64 i = 0;
  int rc = wasiCurrentTimeInt64(pVfs, &i);
  *pTime = (double)i / 86400000.0;
  return rc;
}

static int wasiGetLastError(sqlite3_vfs *pVfs, int nBuf, char *zBuf) {
  (void)pVfs; (void)nBuf; (void)zBuf;
  return 0;
}

sqlite3_vfs *sqlite3_wasi_vfs(void) {
  static sqlite3_vfs wasivfs = {
      2,                    /* iVersion */
      sizeof(WasiFile),     /* szOsFile */
      WASI_VFS_MAXPATH,     /* mxPathname */
      0,                    /* pNext */
      WASI_VFS_NAME,        /* zName */
      0,                    /* pAppData */
      wasiOpen,             /* xOpen */
      wasiDelete,           /* xDelete */
      wasiAccess,           /* xAccess */
      wasiFullPathname,     /* xFullPathname */
      wasiDlOpen,           /* xDlOpen */
      wasiDlError,          /* xDlError */
      wasiDlSym,            /* xDlSym */
      wasiDlClose,          /* xDlClose */
      wasiRandomness,       /* xRandomness */
      wasiSleep,            /* xSleep */
      wasiCurrentTime,      /* xCurrentTime */
      wasiGetLastError,     /* xGetLastError */
      wasiCurrentTimeInt64, /* xCurrentTimeInt64 */
      0, 0, 0               /* v3: xSetSystemCall, xGetSystemCall, xNextSystemCall */
  };
  return &wasivfs;
}

/* Entry points required by -DSQLITE_OS_OTHER=1. */
int sqlite3_os_init(void) {
  return sqlite3_vfs_register(sqlite3_wasi_vfs(), 1);
}

int sqlite3_os_end(void) {
  return SQLITE_OK;
}
