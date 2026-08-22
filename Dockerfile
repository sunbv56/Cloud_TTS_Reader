FROM python:3.12-slim

WORKDIR /app

# Install system dependencies including libjemalloc2 for optimized memory allocation
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libjemalloc2 && rm -rf /var/lib/apt/lists/*

# Optimize memory allocation: smooth 1000ms decay, 1 arena, Python bytecode & gRPC
ENV LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2
ENV MALLOC_CONF="background_thread:false,dirty_decay_ms:1000,muzzy_decay_ms:1000,narenas:1"
ENV MALLOC_TRIM_THRESHOLD_=65536
ENV PYTHONOPTIMIZE=2
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV GRPC_ENABLE_FORK_SUPPORT=0
ENV GRPC_POLL_STRATEGY=epoll1
ENV GRPC_PYTHON_BUILD_SYSTEM_OPENSSL=1

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Expose port
EXPOSE 8008

# Start command
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8008", "--no-access-log"]


