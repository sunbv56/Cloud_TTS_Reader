"""In-process RAM/CPU sampler backing the /monitor page.

Hosts like Botkeep (Pterodactyl) only show live numbers, no history. A
background task samples the container cgroup every SAMPLE_SECONDS and keeps
the last HISTORY_HOURS in a ring buffer (~5,760 tuples, about 1 MB).
History resets on restart, which is acceptable for spotting trends.
"""
import asyncio
import os
import time
from collections import deque
from typing import Optional

SAMPLE_SECONDS = max(5, int(os.getenv("METRICS_SAMPLE_SECONDS", "15")))
HISTORY_HOURS = max(1, int(os.getenv("METRICS_HISTORY_HOURS", "24")))

_samples: deque = deque(maxlen=HISTORY_HOURS * 3600 // SAMPLE_SECONDS)
_task: Optional[asyncio.Task] = None
_last_cpu: Optional[tuple] = None  # (monotonic seconds, cpu usage seconds)


def _read(path: str) -> Optional[str]:
    try:
        with open(path, "r") as f:
            return f.read().strip()
    except OSError:
        return None


def _memory_used_bytes() -> Optional[int]:
    for path in ("/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory/memory.usage_in_bytes"):
        raw = _read(path)
        if raw and raw.isdigit():
            return int(raw)
    return None


def _memory_limit_bytes() -> Optional[int]:
    for path in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        raw = _read(path)
        # cgroup v1 reports "no limit" as a huge number close to 2**63.
        if raw and raw.isdigit() and int(raw) < 1 << 50:
            return int(raw)
    return None


def _cpu_usage_seconds() -> Optional[float]:
    stat = _read("/sys/fs/cgroup/cpu.stat")
    if stat:
        for line in stat.splitlines():
            key, _, value = line.partition(" ")
            if key == "usage_usec" and value.isdigit():
                return int(value) / 1_000_000
    raw = _read("/sys/fs/cgroup/cpuacct/cpuacct.usage")
    if raw and raw.isdigit():
        return int(raw) / 1_000_000_000
    # Outside a container: fall back to this process only.
    return time.process_time()


def _cpu_limit_cores() -> Optional[float]:
    """CPU quota in cores (0.5 = 50%), or None when unlimited."""
    raw = _read("/sys/fs/cgroup/cpu.max")
    if raw:
        quota, _, period = raw.partition(" ")
        if quota != "max" and quota.isdigit() and period.isdigit() and int(period):
            return int(quota) / int(period)
        return None
    quota, period = _read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"), _read("/sys/fs/cgroup/cpu/cpu.cfs_period_us")
    if quota and period and quota.lstrip("-").isdigit() and period.isdigit() and int(quota) > 0:
        return int(quota) / int(period)
    return None


def _process_rss_bytes() -> Optional[int]:
    status = _read("/proc/self/status")
    if status:
        for line in status.splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) * 1024
    return None


# Field order of the tuples kept in _samples (tuples cost ~half of dicts).
FIELDS = ("t", "mem_mb", "rss_mb", "mem_limit_mb", "cpu_pct", "cpu_limit_pct")


def _round(value, digits=1):
    return round(value, digits) if value is not None else None


def take_sample() -> tuple:
    """One snapshot. CPU is the share of one core used since the previous call."""
    global _last_cpu
    now = time.monotonic()
    usage = _cpu_usage_seconds()
    cpu_cores = None
    if usage is not None and _last_cpu is not None and now > _last_cpu[0]:
        cpu_cores = max(0.0, (usage - _last_cpu[1]) / (now - _last_cpu[0]))
    if usage is not None:
        _last_cpu = (now, usage)

    mb = 1024 * 1024
    used, limit, rss = _memory_used_bytes(), _memory_limit_bytes(), _process_rss_bytes()
    cpu_limit = _cpu_limit_cores()
    return (
        int(time.time()),
        _round(used / mb if used is not None else None),
        _round(rss / mb if rss is not None else None),
        _round(limit / mb if limit is not None else None),
        # Percent of ONE core, matching how Botkeep shows CPU (50% = 0.5 vCore).
        _round(cpu_cores * 100 if cpu_cores is not None else None, 2),
        _round(cpu_limit * 100 if cpu_limit is not None else None),
    )


async def _sampler_loop() -> None:
    take_sample()  # prime the CPU baseline
    while True:
        await asyncio.sleep(SAMPLE_SECONDS)
        try:
            _samples.append(take_sample())
        except Exception:
            pass  # never let monitoring take the app down


def start_sampler() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.get_running_loop().create_task(_sampler_loop())


async def stop_sampler() -> None:
    global _task
    if _task is not None:
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:
            pass
        _task = None


def history(minutes: int) -> list:
    cutoff = time.time() - minutes * 60
    return [dict(zip(FIELDS, s)) for s in _samples if s[0] >= cutoff]


def latest() -> Optional[dict]:
    return dict(zip(FIELDS, _samples[-1])) if _samples else None
