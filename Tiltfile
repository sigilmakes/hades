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
        'scripts',
        'examples',
        'infra/docker/Dockerfile.api',
    ],
    live_update=[
        fall_back_on(['./package.json', './package-lock.json', './tsconfig.json']),
        sync('./src', '/app/src'),
        sync('./bin', '/app/bin'),
        sync('./scripts', '/app/scripts'),
        # Rebuild dist/ on src change so the running pod picks up code edits.
        run('npm run build', trigger='./src/**'),
    ],
)

# ── Brain image ──
# Not deployed as a static k8s resource — the controller creates brain pods
# dynamically per agent. Built + loaded into kind by load-brain-image below
# (Tilt skips docker_build images not referenced by a manifest).

# Load the brain image into kind. Tilt can't auto-load images not referenced by
# a k8s manifest, so build + load explicitly in one step (the docker_build above
# is suppressed/unused; this local_resource is the real build+load).
local_resource(
    'load-brain-image',
    'docker build -t hades-brain:latest -f infra/docker/Dockerfile.brain . && kind load docker-image hades-brain:latest --name hades',
    deps=['infra/docker/Dockerfile.brain', 'src', 'package.json', 'package-lock.json', 'tsconfig.json', 'scripts'],
    labels=['build'],
)

# ── Control plane Deployment ──
k8s_yaml(['infra/k8s/api.yaml'])
k8s_resource(
    'hades-api',
    port_forwards=['7347:7347'],
    labels=['app'],
)
