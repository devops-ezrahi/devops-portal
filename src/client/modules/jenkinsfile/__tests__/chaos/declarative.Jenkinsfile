@Library('jenkins-k8s-shared-library') _

pipeline {
    agent { kubernetes { inheritFrom 'kubeagent-jnlp' } }
    options { timeout(time: 1, unit: 'HOURS'); buildDiscarder(logRotator(numToKeepStr: '10')) }
    parameters {
        booleanParam(name: 'skipImage', defaultValue: false, description: 'skip it')
        choice(name: 'ENV', choices: ['dev', 'prod'], description: 'where')
    }
    stages {
        stage('Build') {
            steps {
                script {
                    genStage(title: 'Build', image: 'mvn353-jdk17', commands: ['mvn -B package'])
                }
            }
        }
        stage('Sonar') {
            when { expression { !params.skipImage } }
            steps { script { sonarStage(title: 'Sonar') } }
        }
    }
    post { always { echo 'done' } }
}
