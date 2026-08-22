"""Memory optimization and garbage collection helpers."""
import gc
import ctypes


def _reclaim_memory():
    """Force Python garbage collection and return free pages to the OS (glibc/jemalloc)."""
    gc.collect()
    try:
        if hasattr(ctypes, "CDLL"):
            # Try glibc malloc_trim
            try:
                libc = ctypes.CDLL("libc.so.6")
                if hasattr(libc, "malloc_trim"):
                    libc.malloc_trim(0)
            except Exception:
                pass

            # Try jemalloc mallctl purge if libjemalloc is preloaded
            try:
                jemalloc = ctypes.CDLL("libjemalloc.so.2")
                if hasattr(jemalloc, "mallctl"):
                    # Purge all arenas
                    jemalloc.mallctl(b"arena.4096.purge\x00", None, None, None, 0)
            except Exception:
                pass
    except Exception:
        pass

