"""Memory optimization and garbage collection helpers."""
import gc
import ctypes


def _reclaim_memory():
    """Force Python garbage collection and return free pages to the OS (glibc/jemalloc)."""
    gc.collect()
    try:
        if hasattr(ctypes, "CDLL"):
            libc = ctypes.CDLL("libc.so.6")
            if hasattr(libc, "malloc_trim"):
                libc.malloc_trim(0)
    except Exception:
        pass
