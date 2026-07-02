pipeline {
    agent {
        kubernetes {
            label 'jenkins-agent'
            defaultContainer 'jnlp'
            yaml '''
apiVersion: v1
kind: Pod
spec:
  serviceAccountName: jenkins
  containers:
    - name: jnlp
      image: jenkins/inbound-agent:3256.v88a_f6e922152-1
      resources:
        requests:
          memory: "256Mi"
          cpu: "250m"
        limits:
          memory: "512Mi"
          cpu: "500m"

    - name: docker
      image: docker:27-cli
      command: ["cat"]
      tty: true
      volumeMounts:
        - name: docker-sock
          mountPath: /var/run/docker.sock
      resources:
        requests:
          memory: "256Mi"
          cpu: "250m"
        limits:
          memory: "512Mi"
          cpu: "500m"

    - name: git-tools
      image: alpine/git:latest
      command: ["cat"]
      tty: true
      resources:
        requests:
          memory: "128Mi"
          cpu: "100m"
        limits:
          memory: "256Mi"
          cpu: "200m"

    - name: kube
      image: bitnami/kubectl:1.30
      command: ["cat"]
      tty: true
      resources:
        requests:
          memory: "128Mi"
          cpu: "100m"
        limits:
          memory: "256Mi"
          cpu: "200m"

  volumes:
    - name: docker-sock
      hostPath:
        path: /var/run/docker.sock
        type: Socket
'''
        }
    }

    environment {
        REGISTRY        = "registry.localhost:5000"
        IMAGE_NAME      = "devops-portal"
        IMAGE_FULL      = "${REGISTRY}/${IMAGE_NAME}"
        GITEA_REPO_PATH = "gitea_admin/home-lab"
        MANIFESTS_PATH  = "manifests/devops-portal"
        ARGOCD_APP      = "devops-portal"
    }

    options {
        buildDiscarder(logRotator(numToKeepStr: '10'))
        timeout(time: 30, unit: 'MINUTES')
        ansiColor('xterm')
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
                script {
                    env.GIT_SHA = sh(
                        script: 'git rev-parse --short HEAD',
                        returnStdout: true
                    ).trim()
                    env.IMAGE_TAG        = "${IMAGE_FULL}:${GIT_SHA}"
                    env.IMAGE_TAG_LATEST = "${IMAGE_FULL}:latest"
                    echo "Building image: ${IMAGE_TAG}"
                }
            }
        }

        stage('Test') {
            steps {
                container('docker') {
                    sh """
                        docker run --rm \\
                          -v \$(pwd):/app \\
                          -w /app \\
                          node:20-alpine \\
                          sh -c 'npm ci && npm test'
                    """
                }
            }
        }

        stage('Build Image') {
            steps {
                container('docker') {
                    sh """
                        docker build \\
                          --tag ${IMAGE_TAG} \\
                          --tag ${IMAGE_TAG_LATEST} \\
                          --cache-from ${IMAGE_TAG_LATEST} \\
                          .
                    """
                }
            }
        }

        stage('Push to Registry') {
            steps {
                container('docker') {
                    sh """
                        docker push ${IMAGE_TAG}
                        docker push ${IMAGE_TAG_LATEST}
                    """
                }
            }
        }

        stage('Update Manifest') {
            steps {
                container('git-tools') {
                    withCredentials([usernamePassword(
                        credentialsId: 'gitea-credentials',
                        usernameVariable: 'GITEA_USER',
                        passwordVariable: 'GITEA_PASS'
                    )]) {
                        sh """
                            git clone http://\${GITEA_USER}:\${GITEA_PASS}@gitea-http.gitea.svc.cluster.local:3000/${GITEA_REPO_PATH}.git /tmp/home-lab
                            cd /tmp/home-lab

                            git config user.email "jenkins@homelab.local"
                            git config user.name "Jenkins CI"

                            sed -i "s|image: ${REGISTRY}/${IMAGE_NAME}:.*|image: ${IMAGE_TAG}|g" \\
                                ${MANIFESTS_PATH}/deployment.yaml

                            if git diff --quiet; then
                                echo "No manifest changes"
                            else
                                git add ${MANIFESTS_PATH}/deployment.yaml
                                git commit -m "ci: update devops-portal to ${GIT_SHA}

Built by Jenkins \${JOB_NAME} #\${BUILD_NUMBER}
Image: ${IMAGE_TAG}"
                                git push origin main
                                echo "Manifest updated and pushed"
                            fi
                        """
                    }
                }
            }
        }

        stage('Trigger ArgoCD Sync') {
            steps {
                container('kube') {
                    sh """
                        kubectl patch application ${ARGOCD_APP} \\
                            -n argocd \\
                            --type merge \\
                            -p '{"operation":{"initiatedBy":{"username":"jenkins"},"sync":{"revision":"HEAD","prune":true}}}'
                        echo "ArgoCD sync triggered"
                    """
                }
            }
            post {
                failure {
                    echo 'ArgoCD sync trigger failed — it will auto-sync on next poll.'
                }
            }
        }

        stage('Verify Deployment') {
            steps {
                container('kube') {
                    sh """
                        kubectl rollout status deployment/devops-portal \\
                            -n devops-portal \\
                            --timeout=120s
                        kubectl get pods -n devops-portal
                    """
                }
            }
        }
    }

    post {
        always {
            container('docker') {
                sh "docker rmi ${IMAGE_TAG} 2>/dev/null || true"
            }
        }
        success {
            echo "Build SUCCESS — image: ${IMAGE_TAG}"
        }
        failure {
            echo 'Pipeline failed. Check logs above.'
        }
    }
}
