package vcluster

import (
	"fmt"
	"strings"
)

// CoreDNSImage is the cluster DNS image every instance runs. vCluster's own deployment of it is
// replaced (see InstanceValues), so the operator pins it.
const CoreDNSImage = "docker.io/coredns/coredns:1.14.2"

// InstanceValues are the vCluster chart values a platform instance needs (#270), proven by the
// proving-grounds Layer 3 run inside a vCluster on KubeSolo (2026-10-17):
//
//   - The OSS build of vCluster.
//   - NetworkPolicies sync to the host, whose single policy engine enforces them (the platform
//     runs with networkPolicyEngine=existing inside the instance).
//   - Standard cluster DNS: CoreDNS labelled k8s-app=kube-dns and listening on 53. vCluster's
//     default (k8s-app=vcluster-kube-dns on 1053) is dropped by the platform's DNS egress
//     NetworkPolicies, which allow k8s-app in (kube-dns, coredns) on port 53.
//   - CoreDNS forwards to the host's kube-dns: KubeSolo nodes have an empty resolv.conf.
//   - The proxy certificate also names the instance's Service by its .svc names, which the
//     operator's kubeconfig uses (vCluster's own SANs stop at "<release>.<namespace>"), and
//     127.0.0.1 and localhost for port-forwarded access.
//
// The values apply at creation only. A later chart upgrade does not carry a changed CoreDNS
// config to the host-side synced ConfigMap, so changing these needs a recreate.
func InstanceValues(hostDNS, hostNamespace string) (map[string]any, error) {
	if hostDNS == "" {
		return nil, fmt.Errorf("host kube-dns ClusterIP is unknown")
	}
	if hostNamespace == "" {
		return nil, fmt.Errorf("host namespace is unknown")
	}
	corefile := strings.ReplaceAll(corefileTemplate, "HOST_DNS", hostDNS)
	return map[string]any{
		"sync": map[string]any{
			"toHost": map[string]any{
				"networkPolicies": map[string]any{"enabled": true},
			},
		},
		"controlPlane": map[string]any{
			"statefulSet": map[string]any{
				"image": map[string]any{"repository": "loft-sh/vcluster-oss"},
			},
			"proxy": map[string]any{
				"extraSANs": []any{
					"127.0.0.1",
					"localhost",
					ReleaseName + "." + hostNamespace + ".svc",
					ReleaseName + "." + hostNamespace + ".svc.cluster.local",
				},
			},
			"coredns": map[string]any{
				"overwriteConfig":    corefile,
				"overwriteManifests": strings.ReplaceAll(manifestsTemplate, "COREFILE", indent(corefile, "    ")),
			},
		},
	}, nil
}

func indent(s, prefix string) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	for i, l := range lines {
		if l != "" {
			lines[i] = prefix + l
		}
	}
	return strings.Join(lines, "\n") + "\n"
}

// corefileTemplate is vCluster 0.37.3's generated Corefile with the listen port 53 and the
// upstream set to the host kube-dns (HOST_DNS).
const corefileTemplate = `.:53 {
    errors
    health
    ready
    rewrite name regex .*\.nodes\.vcluster\.com kubernetes.default.svc.cluster.local
    kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
    }
    hosts /etc/coredns/NodeHosts {
        ttl 60
        reload 15s
        fallthrough
    }
    prometheus :9153
    forward . HOST_DNS
    cache 30
    loop
    reload
    loadbalance
}

import /etc/coredns/custom/*.server
`

// manifestsTemplate is vCluster 0.37.3's CoreDNS objects as it deploys them, relabelled
// k8s-app=kube-dns and serving on 53. NET_BIND_SERVICE lets the non-root user bind 53.
const manifestsTemplate = `apiVersion: v1
kind: ServiceAccount
metadata: {name: coredns, namespace: kube-system}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: {name: "system:coredns"}
rules:
  - apiGroups: [""]
    resources: [endpoints, services, pods, namespaces]
    verbs: [list, watch]
  - apiGroups: [discovery.k8s.io]
    resources: [endpointslices]
    verbs: [list, watch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: {name: "system:coredns"}
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: "system:coredns"}
subjects: [{kind: ServiceAccount, name: coredns, namespace: kube-system}]
---
apiVersion: v1
kind: ConfigMap
metadata: {name: coredns, namespace: kube-system}
data:
  NodeHosts: ""
  Corefile: |
COREFILE---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: coredns
  namespace: kube-system
  labels: {k8s-app: kube-dns, kubernetes.io/name: CoreDNS}
spec:
  replicas: 1
  strategy: {type: RollingUpdate, rollingUpdate: {maxUnavailable: 1}}
  selector: {matchLabels: {k8s-app: kube-dns}}
  template:
    metadata: {labels: {k8s-app: kube-dns}}
    spec:
      serviceAccountName: coredns
      dnsPolicy: Default
      nodeSelector: {kubernetes.io/os: linux}
      containers:
        - name: coredns
          image: ` + CoreDNSImage + `
          imagePullPolicy: IfNotPresent
          args: [-conf, /etc/coredns/Corefile]
          ports:
            - {name: dns, containerPort: 53, protocol: UDP}
            - {name: dns-tcp, containerPort: 53, protocol: TCP}
            - {name: metrics, containerPort: 9153, protocol: TCP}
          livenessProbe: {httpGet: {path: /health, port: 8080}, initialDelaySeconds: 60, periodSeconds: 10, failureThreshold: 3}
          readinessProbe: {httpGet: {path: /ready, port: 8181}, periodSeconds: 2, failureThreshold: 3}
          resources:
            limits: {cpu: 1000m, memory: 170Mi}
            requests: {cpu: 20m, memory: 64Mi}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities: {add: [NET_BIND_SERVICE], drop: [ALL]}
            readOnlyRootFilesystem: true
            runAsGroup: 1001
            runAsNonRoot: true
            runAsUser: 1001
          volumeMounts:
            - {name: config-volume, mountPath: /etc/coredns, readOnly: true}
            - {name: custom-config-volume, mountPath: /etc/coredns/custom, readOnly: true}
      volumes:
        - name: config-volume
          configMap:
            name: coredns
            items: [{key: Corefile, path: Corefile}, {key: NodeHosts, path: NodeHosts}]
        - name: custom-config-volume
          configMap: {name: coredns-custom, optional: true}
---
apiVersion: v1
kind: Service
metadata:
  name: kube-dns
  namespace: kube-system
  labels: {k8s-app: kube-dns, kubernetes.io/cluster-service: "true", kubernetes.io/name: CoreDNS}
spec:
  selector: {k8s-app: kube-dns}
  ports:
    - {name: dns, port: 53, protocol: UDP, targetPort: 53}
    - {name: dns-tcp, port: 53, protocol: TCP, targetPort: 53}
    - {name: metrics, port: 9153, protocol: TCP, targetPort: 9153}
`
