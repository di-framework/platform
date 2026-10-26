package vcluster

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"regexp"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/yaml"
)

// normalize round-trips through JSON so Go-built and YAML-parsed values compare alike.
func normalize(t *testing.T, v any) map[string]any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// documents parses a multi-document YAML string into objects.
func documents(t *testing.T, s string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, doc := range strings.Split(s, "\n---\n") {
		if strings.TrimSpace(doc) == "" {
			continue
		}
		// The separator's leading newline ends the previous document's last line.
		doc += "\n"
		var obj map[string]any
		if err := yaml.Unmarshal([]byte(doc), &obj); err != nil {
			t.Fatalf("parse %q: %v", doc[:min(len(doc), 60)], err)
		}
		out = append(out, obj)
	}
	return out
}

// coredns pops the CoreDNS values out of a values map, leaving the rest to compare as a whole.
func coredns(t *testing.T, v map[string]any) (corefile string, manifests []map[string]any) {
	t.Helper()
	cp := v["controlPlane"].(map[string]any)
	dns := cp["coredns"].(map[string]any)
	delete(cp, "coredns")
	return dns["overwriteConfig"].(string), documents(t, dns["overwriteManifests"].(string))
}

func TestInstanceValuesMatchTheLayer3PassingValues(t *testing.T) {
	raw, err := os.ReadFile("testdata/layer3-pass-values.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var proven map[string]any
	if err := yaml.Unmarshal(raw, &proven); err != nil {
		t.Fatal(err)
	}
	got, err := InstanceValues("10.43.0.10", "vc-pgvc") // that run's host kube-dns and namespace
	if err != nil {
		t.Fatal(err)
	}
	// The one addition since that run: the .svc names the operator's kubeconfig addresses.
	// That run reached the vCluster through a port-forward, so it needed only 127.0.0.1.
	sans := proven["controlPlane"].(map[string]any)["proxy"].(map[string]any)
	sans["extraSANs"] = append(sans["extraSANs"].([]any), "vcluster.vc-pgvc.svc", "vcluster.vc-pgvc.svc.cluster.local")
	want, have := normalize(t, proven), normalize(t, got)
	wantCorefile, wantManifests := coredns(t, want)
	haveCorefile, haveManifests := coredns(t, have)

	if haveCorefile != wantCorefile {
		t.Fatalf("Corefile differs:\n--- proven\n%s\n--- rendered\n%s", wantCorefile, haveCorefile)
	}
	if !reflect.DeepEqual(haveManifests, wantManifests) {
		w, _ := json.MarshalIndent(wantManifests, "", " ")
		h, _ := json.MarshalIndent(haveManifests, "", " ")
		t.Fatalf("CoreDNS manifests differ:\n--- proven\n%s\n--- rendered\n%s", w, h)
	}
	if !reflect.DeepEqual(have, want) {
		t.Fatalf("values differ:\nproven   %v\nrendered %v", want, have)
	}
	// The ConfigMap the manifests deploy carries the same Corefile.
	data := haveManifests[3]["data"].(map[string]any)
	if !bytes.Equal([]byte(data["Corefile"].(string)), []byte(haveCorefile)) {
		t.Fatalf("manifest ConfigMap Corefile differs from overwriteConfig:\n%q\n%q", data["Corefile"], haveCorefile)
	}
}

var digestPinned = regexp.MustCompile(`^docker\.io/coredns/coredns:[0-9.]+@sha256:[0-9a-f]{64}$`)

func TestCoreDNSImageIsDigestPinned(t *testing.T) {
	if !digestPinned.MatchString(CoreDNSImage) {
		t.Fatalf("CoreDNSImage %q is not pinned by digest", CoreDNSImage)
	}
	v, err := InstanceValues("10.43.0.10", "pi-a-b")
	if err != nil {
		t.Fatal(err)
	}
	_, manifests := coredns(t, normalize(t, v))
	var images []string
	for _, obj := range manifests {
		if obj["kind"] != "Deployment" {
			continue
		}
		pod := obj["spec"].(map[string]any)["template"].(map[string]any)["spec"].(map[string]any)
		for _, c := range pod["containers"].([]any) {
			images = append(images, c.(map[string]any)["image"].(string))
		}
	}
	if len(images) != 1 || images[0] != CoreDNSImage {
		t.Fatalf("CoreDNS Deployment images %q, want [%q]", images, CoreDNSImage)
	}
}

func TestInstanceValuesNeedTheHostDNS(t *testing.T) {
	if _, err := InstanceValues("", "pi-a-b"); err == nil {
		t.Fatal("empty host DNS must be refused")
	}
	if _, err := InstanceValues("10.43.0.10", ""); err == nil {
		t.Fatal("empty host namespace must be refused")
	}
}

func TestEnsureUsesTheHostDNSService(t *testing.T) {
	inst := instance("team-a", "one")
	helm := &fakeHelm{installed: map[string]map[string]any{}}
	c := newClient(t, &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Namespace: "kube-system", Name: "kube-dns"},
		Spec:       corev1.ServiceSpec{ClusterIP: "10.43.0.99"},
	})
	if _, err := (&Target{Client: c, Helm: helm, OperatorNamespace: operatorNS}).Ensure(context.Background(), inst); err != nil {
		t.Fatal(err)
	}
	corefile, _ := coredns(t, normalize(t, helm.installed[HostNamespace(inst)]))
	if !strings.Contains(corefile, "forward . 10.43.0.99\n") {
		t.Fatalf("Corefile does not forward to the host DNS:\n%s", corefile)
	}
	sans := normalize(t, helm.installed[HostNamespace(inst)])["controlPlane"].(map[string]any)["proxy"].(map[string]any)["extraSANs"]
	if !strings.Contains(fmt.Sprint(sans), "vcluster."+HostNamespace(inst)+".svc ") {
		t.Fatalf("proxy SANs %v lack the .svc name the kubeconfig uses", sans)
	}

	// Without the host DNS Service nothing is installed.
	other := instance("team-b", "two")
	if _, err := (&Target{Client: newClient(t), Helm: helm, OperatorNamespace: operatorNS}).Ensure(context.Background(), other); err == nil {
		t.Fatal("Ensure must fail without the host DNS Service")
	}
	if _, ok := helm.installed[HostNamespace(other)]; ok {
		t.Fatal("installed without host DNS")
	}
}
