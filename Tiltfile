# -*- mode: Python -*-

update_settings(max_parallel_updates=3)

# ── k8s Infrastructure ──
k8s_yaml([
    'infra/k8s/namespace-rbac.yaml',
    'infra/k8s/crds/hades.dev_resources.yaml',
])

# ── Hades control plane (API + controller) ──
docker_build(
    'hades-api',
    '.',
    dockerfile='infra/docker/Dockerfile.api',
    only=[
        'package.json',
        'package-lock.json',
        'tsconfig.json',
        'src',
        'bin',
        'examples',
        'infra/docker/Dockerfile.api',
    ],
    live_update=[
        fall_back_on(['./package.json', './package-lock.json', './tsconfig.json']),
        sync('./src', '/app/src'),
        sync('./bin', '/app/bin'),
    ],
)

# ── Brain image ──
# Not deployed as a static k8s resource — the controller creates brain pods
# dynamically per agent. Build it and load into kind so the controller can
# reference the image.
docker_build(
    'hades-brain',
    '.',
    dockerfile='infra/docker/Dockerfile.brain',
    only=[
        'package.json',
        'package-lock.json',
        'tsconfig.json',
        'src',
        'infra/docker/Dockerfile.brain',
    ],
    live_update=[
        fall_back_on(['./package.json', './package-lock.json', './tsconfig.json']),
        sync('./src', '/app/src'),
    ],
)

# Hands pods use a base image (node:24-slim, sleep infinity) — no custom build
# needed. The controller creates them per agent; the brain execs into them.

# Load the brain image into kind (no k8s resource references it directly —
# the controller creates brain pods from it).
local_resource(
    'load-brain-image',
    'kind load docker-image hades-brain:latest --name hades',
    deps=['infra/docker/Dockerfile.brain'],
    resource_deps=['hades-brain'],
    labels=['build'],
)

# ── Control plane Deployment ──
k8s_yaml(['infra/k8s/api.yaml'])
k8s_resource(
    'hades-api',
    port_forwards=['7347:7347'],
    labels=['app'],
)
