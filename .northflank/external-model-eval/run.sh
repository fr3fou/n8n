#!/usr/bin/env bash
set -euo pipefail

: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required for grading}"
: "${MODEL_URL:?MODEL_URL is required}"

MODEL="${MODEL:-custom/Kimi-K3}"
EVAL_SUITE="${EVAL_SUITE:-model-comparison}"
EVAL_LANES="${EVAL_LANES:-2}"
EVAL_CONCURRENCY="${EVAL_CONCURRENCY:-4}"
EVAL_ITERATIONS="${EVAL_ITERATIONS:-1}"
EVAL_EXPERIMENT_NAME="${EVAL_EXPERIMENT_NAME:-model-comparison-kimi-k3-northflank}"
SANDBOX_PROVIDER="${SANDBOX_PROVIDER:-n8n-sandbox}"
DOCKER_STORAGE_DRIVER="${DOCKER_STORAGE_DRIVER:-vfs}"
DOCKER_CGROUPNS_MODE="${DOCKER_CGROUPNS_MODE:-host}"

dockerd \
	--host=unix:///var/run/docker.sock \
	--default-cgroupns-mode="${DOCKER_CGROUPNS_MODE}" \
	--storage-driver="${DOCKER_STORAGE_DRIVER}" \
	>/tmp/dockerd.log 2>&1 &

for _ in $(seq 1 90); do
	if docker info >/dev/null 2>&1; then
		break
	fi
	sleep 1
done

if ! docker info >/dev/null 2>&1; then
	tail -n 100 /tmp/dockerd.log >&2
	echo "Docker daemon did not become ready" >&2
	exit 1
fi

cd /workspace/n8n

# The repository and compiled deployment are baked into this image. Only the
# inner image required by the eval lanes is assembled at job runtime.
docker build \
	--platform linux/amd64 \
	--build-arg TARGETPLATFORM=linux/amd64 \
	-t n8nio/n8n:local \
	-f docker/images/n8n/Dockerfile \
	.

touch .env.local

args=(
	--model "${MODEL}"
	--model-url "${MODEL_URL}"
	--suite "${EVAL_SUITE}"
	--experiment-name "${EVAL_EXPERIMENT_NAME}"
	--sandbox-provider "${SANDBOX_PROVIDER}"
	--lanes "${EVAL_LANES}"
	--concurrency "${EVAL_CONCURRENCY}"
	--iterations "${EVAL_ITERATIONS}"
)

if [[ -n "${EVAL_FILTER:-}" ]]; then
	args+=(--filter "${EVAL_FILTER}")
fi

exec ./packages/@n8n/instance-ai/scripts/run-eval-experiment.sh "${args[@]}"
