import { describe, expect, it } from "vitest";
import { importValues } from "./import";

/**
 * Every feature whose value is a `name`-keyed map is edited as rows, and rows
 * are what a field's `path` cannot invert. Without a `load` each one imported as
 * a ticked, empty card while its real content sat in `extraValues` — which is
 * how a pull of a real values repo came back "with 4 warnings".
 *
 * So this is the one check that pins all of them at once: a document holding
 * every such key goes in, and nothing is left over.
 */
const VALUES = `
volumes:
  nginx-conf:
    configMap:
      name: nginx-config
      defaultMode: 420
  creds:
    secret:
      secretName: db-secret
  cache:
    emptyDir:
      sizeLimit: 512Mi
  scratch:
    emptyDir: {}
  shm:
    emptyDir:
      medium: Memory
  data:
    persistentVolumeClaim:
      claimName: app-data
  hostlogs:
    hostPath:
      path: /var/log
  exports:
    nfs:
      server: nfs.internal.example.com
      path: /exports/myapp
  vault:
    csi:
      driver: secrets-store.csi.k8s.io
      readOnly: true
volumeMounts:
  nginx-conf:
    mountPath: /etc/nginx/conf.d
    subPath: nginx.conf
    readOnly: true
pvc:
  app-data:
    accessModes:
      - ReadWriteMany
    size: 50Gi
    storageClassName: fast-ssd
    volumeMode: Filesystem
    volumeName: pv-app-data
volumeClaimTemplates:
  data:
    accessModes:
      - ReadWriteOnce
    size: 100Gi
    storageClassName: fast-ssd
persistentVolumeClaimRetentionPolicy:
  whenDeleted: Retain
  whenScaled: Retain
persistentVolumes:
  local-ssd-node1:
    capacity: 200Gi
    accessModes: [ReadWriteOnce]
    reclaimPolicy: Retain
    storageClassName: local-storage
    local:
      path: /mnt/ssd
storageClasses:
  fast-ssd:
    provisioner: ebs.csi.aws.com
    reclaimPolicy: Delete
    volumeBindingMode: WaitForFirstConsumer
    allowVolumeExpansion: true
    parameters:
      type: gp3
      iops: "16000"
services:
  admin:
    enabled: true
    type: ClusterIP
    ports:
      admin-http:
        port: 8081
        targetPort: 8081
    clusterIP: None
    publishNotReadyAddresses: true
    selector:
      app: legacy-app
routes:
  admin-console:
    enabled: true
    host: admin.apps.cluster.example.com
    path: /
    targetPort: admin-http
    serviceName: admin
    tls:
      termination: edge
networkPolicies:
  backend-allow-from-frontend:
    podSelector:
      matchLabels:
        app.kubernetes.io/name: backend
    policyTypes: [Ingress]
configMaps:
  app-config:
    data:
      LOG_LEVEL: info
      MAX_CONNECTIONS: "100"
      nginx.conf: |
        server {
          listen 80;
        }
secrets:
  db-secret:
    type: Opaque
    stringData:
      DB_PASSWORD: super-secret
    data:
      DB_USER: cG9zdGdyZXM=
externalSecretsApiVersion: external-secrets.io/v1
secretStores:
  vault-backend:
    provider:
      vault:
        server: https://vault.example.com:8200
        path: secret
clusterSecretStores:
  shared-vault:
    provider:
      vault:
        server: https://vault.example.com:8200
externalSecrets:
  db-credentials:
    secretStoreRef:
      name: vault-backend
      kind: SecretStore
    refreshInterval: 1h
    target:
      name: db-secret
    data:
      - secretKey: password
        remoteRef:
          key: secret/data/myapp/db
          property: password
    dataFrom:
      - extract:
          key: secret/data/myapp/all
cronjobs:
  db-backup:
    schedule: 0 2 * * *
    concurrencyPolicy: Forbid
    suspend: true
    successfulJobsHistoryLimit: 3
    failedJobsHistoryLimit: 1
    startingDeadlineSeconds: 300
    jobTemplate:
      restartPolicy: OnFailure
      backoffLimit: 3
      activeDeadlineSeconds: 3600
      ttlSecondsAfterFinished: 86400
      containerName: backup
      serviceAccountName: backup-sa
      command:
        - /bin/sh
        - "-c"
        - pg_dump
      env:
        DATABASE_URL:
          valueFrom:
            secretKeyRef:
              name: db-secret
              key: DATABASE_URL
        MODE:
          value: full
      image:
        repository: postgres
        tag: "16.3"
        pullPolicy: IfNotPresent
jobs:
  db-migrate:
    restartPolicy: Never
    backoffLimit: 1
    ttlSecondsAfterFinished: 3600
    containerName: migrate
    command:
      - python
      - manage.py
      - migrate
    env:
      MODE:
        value: up
    image:
      repository: myapp
      tag: 1.0.0
    annotations:
      argocd.argoproj.io/hook: PreSync
      argocd.argoproj.io/hook-delete-policy: HookSucceeded
scc:
  myapp-scc:
    allowPrivilegeEscalation: false
    runAsUser:
      type: MustRunAsNonRoot
rbac:
  roles:
    myapp-role:
      rules:
        - apiGroups: [""]
          resources: [configmaps]
          verbs: [get, list]
  roleBindings:
    myapp-rolebinding:
      roleRef: myapp-role
      subjects:
        - kind: ServiceAccount
          name: myapp-sa
  clusterRoles:
    myapp-cluster-reader:
      rules:
        - apiGroups: [""]
          resources: [nodes]
          verbs: [get]
  clusterRoleBindings:
    myapp-cluster-rb:
      roleRef: myapp-cluster-reader
      subjects:
        - kind: ServiceAccount
          name: myapp-sa
          namespace: myapp-dev
sidecars:
  log-shipper:
    image: fluentbit:2.0
    resources:
      requests:
        cpu: 50m
initContainers:
  init-db:
    image: busybox:1.36
    command: [sh, "-c", "until nc -z db 5432; do sleep 2; done"]
serviceMonitor:
  enabled: true
  port: http
  labels:
    release: prometheus
  tlsConfig:
    insecureSkipVerify: true
  relabelings:
    - sourceLabels: [__meta_kubernetes_pod_name]
      targetLabel: pod
nodeSelector:
  disktype: ssd
tolerations:
  - key: nvidia.com/gpu
    operator: Exists
    effect: NoSchedule
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: kubernetes.io/hostname
    whenUnsatisfiable: DoNotSchedule
`;

describe("importing every rows-based feature", () => {
  const result = importValues(VALUES);

  it("keeps nothing back as extra values", () => {
    expect(result.warnings).toEqual([]);
    expect(result.extraValues).toBe("");
  });

  it("switches each feature on with its rows filled in", () => {
    for (const id of [
      "volumes",
      "mounts",
      "pvc",
      "vct",
      "pv",
      "storageclass",
      "services",
      "routes",
      "netpol",
      "configmaps",
      "secrets",
      "secretstores",
      "externalsecrets",
      "cronjobs",
      "jobs",
      "scc",
      "rbac",
      "sidecars",
      // Not rows, but the same gap: `kv` and `yaml` fields have no path to read through.
      "servicemonitor",
      "scheduling",
    ]) {
      expect(result.features[id]?.on, id).toBe(true);
      expect(Object.values(result.features[id].v).some((v) => (Array.isArray(v) ? v.length : v)), id).toBeTruthy();
    }
  });

  it("reads the two plain fields a rows feature also has", () => {
    // `load` is merged over the path-derived read, not a replacement for it.
    expect(result.features.vct.v.whenDeleted).toBe("Retain");
    expect(result.features.secretstores.v.apiVersion).toBe("external-secrets.io/v1");
  });

  it("does not switch a feature on when its key holds nothing to show", () => {
    const empty = importValues("configMaps: {}\nimage:\n  repository: nginx\n");
    expect(empty.features.configmaps).toBeUndefined();
  });
});
