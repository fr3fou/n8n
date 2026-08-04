# Northflank external-model eval job

This image pre-installs the monorepo dependencies and produces the compiled n8n
deployment at image-build time. At job runtime it starts Docker-in-Docker,
assembles `n8nio/n8n:local`, and runs the offline Instance AI model-comparison
suite.

The Northflank job must have privileged mode enabled. Provide secrets through
the job runtime environment, never as Docker build arguments.

Required runtime variables:

- `ANTHROPIC_API_KEY`: grading and mock helpers
- `MODEL_URL`: OpenAI-compatible model base URL ending in `/v1`

Optional runtime variables:

- `MODEL` (default `custom/Kimi-K3`)
- `EVAL_SUITE` (default `model-comparison`)
- `EVAL_FILTER` (unset by default)
- `EVAL_LANES` (default `2`)
- `EVAL_CONCURRENCY` (default `4`)
- `EVAL_ITERATIONS` (default `1`)
- `EVAL_EXPERIMENT_NAME`
- `SANDBOX_PROVIDER` (default `n8n-sandbox`)
- `DOCKER_STORAGE_DRIVER` (default `vfs`)
- `DOCKER_CGROUPNS_MODE` (default `host`, required for the nested sandbox runner)
