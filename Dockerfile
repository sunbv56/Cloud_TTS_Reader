FROM python:3.10-slim

WORKDIR /app

# Install system dependencies including libjemalloc2 for optimized memory allocation
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libjemalloc2 && rm -rf /var/lib/apt/lists/*

# Optimize memory allocation and unbuffered output
ENV LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2
ENV MALLOC_TRIM_THRESHOLD_=65536
ENV PYTHONUNBUFFERED=1

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Expose port
EXPOSE 8008

# Start command
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8008"]
