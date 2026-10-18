.PHONY: build test vet generate check

build:
	CGO_ENABLED=0 go build -trimpath -o bin/platform-operator ./cmd/platform-operator

test:
	go test ./...

vet:
	go vet ./...

# Regenerates the DeepCopy methods, the CRD and the operator's ClusterRole from the API markers.
generate:
	go tool controller-gen object paths=./api/...
	go tool controller-gen crd paths=./api/... output:crd:artifacts:config=config/crd
	go tool controller-gen rbac:roleName=platform-operator paths=./internal/controller/... output:rbac:artifacts:config=config/rbac

# CI: generated files must match the markers, gofmt clean, vet and tests pass.
check: generate
	git diff --exit-code -- api config
	test -z "$$(gofmt -l .)"
	go vet ./...
	go test ./...
