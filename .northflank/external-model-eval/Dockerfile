FROM docker:27-dind

ARG PNPM_VERSION=10.32.1

RUN apk add --no-cache \
		bash \
		curl \
		g++ \
		git \
		jq \
		libc6-compat \
		lsof \
		make \
		nodejs \
		npm \
		python3

ENV SHELL=/bin/sh \
	ENV=/root/.profile \
	PNPM_HOME=/root/.local/share/pnpm \
	PATH=/root/.local/share/pnpm:$PATH

RUN curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION=${PNPM_VERSION} sh - \
	&& pnpm --version

WORKDIR /workspace/n8n
COPY . .

RUN pnpm install --frozen-lockfile
RUN INCLUDE_TEST_CONTROLLER=true node scripts/build-n8n.mjs

RUN chmod +x .northflank/external-model-eval/run.sh

ENTRYPOINT ["/workspace/n8n/.northflank/external-model-eval/run.sh"]
