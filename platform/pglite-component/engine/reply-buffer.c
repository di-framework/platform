/* di-framework: collect CMA replies in a growable buffer instead of spilling
 * to the upstream socket-file path when the fixed low-memory area fills.
 * This code replaces internal_putbytes in PostgreSQL's pqcomm.c. */
static unsigned char *di_reply_buffer;
static size_t di_reply_size;
static size_t di_reply_capacity;
#define DI_REPLY_MAX (64U * 1024U * 1024U)

__attribute__((export_name("di_reply_ptr")))
uintptr_t di_reply_ptr(void) { return (uintptr_t) di_reply_buffer; }

__attribute__((export_name("di_reply_reset")))
void di_reply_reset(void) { di_reply_size = 0; }

static int
internal_putbytes(const char *s, size_t len)
{
    if (sockfiles) {
        int written = fwrite(s, 1, len, SOCKET_FILE);
        SOCKET_DATA += written;
        return 0;
    }
    if (len > DI_REPLY_MAX - di_reply_size) {
        /* Discard partial rows, leaving room to serialize this error. */
        di_reply_size = 0;
        SOCKET_DATA = 0;
        ereport(ERROR, (errcode(ERRCODE_PROGRAM_LIMIT_EXCEEDED),
                       errmsg("embedded query result exceeds 64 MiB")));
    }
    size_t needed = di_reply_size + len;
    if (needed > di_reply_capacity) {
        size_t capacity = di_reply_capacity ? di_reply_capacity : 65536;
        while (capacity < needed) capacity *= 2;
        unsigned char *next = realloc(di_reply_buffer, capacity);
        if (!next) {
            di_reply_size = 0;
            SOCKET_DATA = 0;
            ereport(ERROR, (errcode(ERRCODE_OUT_OF_MEMORY),
                           errmsg("cannot allocate embedded query result")));
        }
        di_reply_buffer = next;
        di_reply_capacity = capacity;
    }
    memcpy(di_reply_buffer + di_reply_size, s, len);
    di_reply_size += len;
    SOCKET_DATA += len;
    return 0;
}
