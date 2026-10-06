#!/usr/bin/env groovy
/* =====================================================================
 * billing-service — CI            (owned by team-payments 💳, #payments-ci)
 * DO NOT touch the parallel block without asking — see docs/ci.md
 * =================================================================== */
@Library("jenkins-k8s-shared-library@release/2.x") _

import groovy.transform.Field
import java.text.SimpleDateFormat

@Field String REGISTRY = "artifactory.local/docker-local"
@Field def NOTIFY = ['#payments-ci', '#payments-alerts']   // slack channels
final String DEFAULT_IMAGE = 'mvn353-jdk17'

properties([
    buildDiscarder(logRotator(numToKeepStr: '30', artifactNumToKeepStr: '5')),
    disableConcurrentBuilds(abortPrevious: true),
    pipelineTriggers([cron('H 2 * * 1-5'), pollSCM('H/15 * * * *')]),
    parameters([
        booleanParam(name: 'skipImage', defaultValue: false, description: 'Skip the docker build'),
        booleanParam(defaultValue: true, name: 'RUN_SONAR', description: "Run sonar (default on)"),
        string(name: 'IMAGE_TAG', defaultValue: "${env.BRANCH_NAME}-${env.BUILD_NUMBER}", description: 'Tag to push — defaults to <branch>-<build>'),
        text(name: 'RELEASE_NOTES', defaultValue: '''First line
second line with a 'quote' ''', description: 'Multi-line notes'),
        choice(name: 'TARGET_ENV', choices: ['dev', 'staging', 'prod'], description: 'Where to deploy'),
        choice(name: 'LOG_LEVEL', choices: "info\ndebug\nwarn", description: 'old-style newline-separated choices'),
        password(name: 'DEPLOY_TOKEN', defaultValue: '', description: 'One-off token, never logged'),
    ]),
])

/**
 * Short sha of HEAD — used in tags.
 */
def gitShortSha() {
    return sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
}

def isRelease = env.BRANCH_NAME ==~ /(main|release\/.*)/

String timestamp() {
    return new SimpleDateFormat("yyyyMMdd-HHmm").format(new Date())
}

def notify(String status, Closure extra = {}) {
    def color = status == 'SUCCESS' ? 'good' : "danger"
    NOTIFY.each { ch ->
        slackSend(channel: ch, color: color, message: "${env.JOB_NAME} #${env.BUILD_NUMBER}: ${status} — ${env.BUILD_URL}")
    }
    extra()
}

def buildMatrix(List<String> modules) {
    return modules.collectEntries { m ->
        ["Test ${m}": {
            genStage(title: "Test ${m}", image: DEFAULT_IMAGE, commands: ["mvn -pl ${m} test"])
        }]
    }
}

populateEnvVars([
    SERVICE  : 'billing-service',
    TEAM_NAME: "payments",   // artifactory team
    'BRANCH_TYPE': isRelease ? 'release' : 'development',
])

semVerStage(
    postCommands: ['echo "VERSION=$VERSION"', "echo branch type \$BRANCH_TYPE"],
)

genStage(
        title     : "Build ${env.SERVICE} — ${params.TARGET_ENV == 'prod' ? "PRD" : 'non-prd'}",
    image: 'mvn353-jdk17',
      skipStage: params.skipImage,
    commands  : [
        'mvn -B -ntp clean package -DskipTests',
        "echo built ${modules.join(",")}",
        "printf 'line1\\nline2\\n' > out.txt",   // escaped newline for printf
        'echo "it\'s done"',
    ],
    envVars   : [MAVEN_OPTS: '-Xmx2g -XX:+UseG1GC', 'JAVA_TOOL_OPTIONS': "-Dfile.encoding=UTF-8", EMPTY: ''],
    stash     : [ByteCode: '**/target/*.jar', reports: 'target/surefire-reports/**'],
    unshallow : true,
    junitTestResults: '**/target/surefire-reports/*.xml',
    secrets   : [
        [path: 'secret/payments/billing', key: 'db_password', variableName: 'DB_PASSWORD'],
        [ path : "secret/payments/billing",
          key  : 'api-key',
          variableName : 'API_KEY' ],
    ],
    additionalRepos: [[dir: 'tools', repoURL: 'https://bitbucket.local/scm/pay/tools.git', branch: 'master', files: 'scripts/*.sh']],
    requestStorage: 20,
    resources: [requestCpu: '500m', requestmemory: '2Gi', limitCpu: '2', limitMemory: '8Gi'],
    runAsUser: '0',
    customPVC: [[claimName: 'm2-cache', mountPath: '/home/jenkins/.m2', readOnly: false]],
    /* the wiki says to keep this */ unstash: [],
)

// sonar only when asked
sonarStage(
    title: 'Sonar',
    skipStage: !params.RUN_SONAR,
    projectKey: 'pay:billing',
    projectVersion: "${env.VERSION}",
    extraProps: ['sonar.exclusions': '**/generated/**', 'sonar.coverage.jacoco.xmlReportPaths': 'target/site/jacoco/jacoco.xml'],
    flags: ['-Pcoverage', '-DskipITs'],
    modulePath: 'billing-core',
    unstash: ['ByteCode'],
)

parallel(
    failFast: true,
    'Unit tests': {
        genStage(title: 'Unit tests', image: DEFAULT_IMAGE, commands: { sh 'mvn -B test'; junit '**/surefire-reports/*.xml' })
    },
    'Lint + audit': {
        genStage(title: 'Lint', image: 'node20', commands: ['npm ci', 'npm run lint'])
        genStage(title: 'Audit', image: 'node20', commands: ['npm audit --audit-level=high'])
    },
    'Windows smoke': {
        genStageWindows(title: 'Windows smoke', commands: ['build.bat', 'test.bat /quiet'], unstash: ['ByteCode'])
    },
    'Notify': { echo 'parallel started' }
)

parallel buildMatrix(['billing-core', 'billing-api'])

buildAndUploadImageStage(
    skipStage: params.skipImage || !isRelease,
    dockerfile: 'docker/Dockerfile',
    context: '.',
    labels: [
        'org.opencontainers.image.revision': "${gitShortSha()}",
        team: 'payments',
    ],
    buildArgs: [JAR: 'target/billing.jar', BUILD_DATE: "${timestamp()}"],
    cache: true,
    overwritePrd: false,
    distributeToN: isRelease,
    repoName: 'docker-payments',
    postCommands: {
        sh """
            echo "pushed ${REGISTRY}/billing:${params.IMAGE_TAG}"
            curl -s -X POST https://hooks.local/deploy?env=${params.TARGET_ENV}
        """
        notify('IMAGE_PUSHED') {
            echo 'extra closure param ran'
        }
    },
)

buildAndUploadJarStage(title: "Upload jar", flags: ['-DskipTests', '-Dmaven.javadoc.skip=true'], deployerPomLocation: 'billing-core', parentPomLocation: '.', repoName: 'maven-payments')
buildAndUploadRpmStage(specFile: 'rpm/billing.spec', macros: [_version: "${env.VERSION}", _release: '1'], flags: ['--nodeps'], rpmName: 'billing', path: 'el8/x86_64', repoName: 'rpm-payments')
buildAndUploadWhlStage(title: 'Upload helper wheel', repoName: 'pypi-payments', commands: ['cd tools/py && python -m build'])

AIStage(prompt: 'Review the diff for hardcoded secrets and say "LGTM" only if there are none', image: 'opencode')

smartReleaseStage(postCommands: ['echo released $VERSION'])

mirrorBranchStage(destRepo: 'https://github.com/payments/billing-mirror.git', allowedBranches: ['main', 'release/*'], flags: [])

sleep 30
sleep(time: 2, unit: 'MINUTES')

if (params.TARGET_ENV == 'prod') {
    genStage(title: 'Deploy prod', image: 'kubectl', commands: ['kubectl apply -k overlays/prod'])
} else {
    genStage(title: "Deploy ${params.TARGET_ENV}", image: 'kubectl', commands: ["kubectl apply -k overlays/${params.TARGET_ENV}"])
}

try {
    genStage(title: 'Smoke', image: 'ubi8', commands: ['./smoke.sh'], envVars: [TOKEN: params.DEPLOY_TOKEN])
} catch (err) {
    notify('FAILED')
    throw err
}

timeout(time: 1, unit: 'HOURS') {
    AIStage(title: 'Release notes', prompt: "Write release notes from:\n${params.RELEASE_NOTES}")
}

node('built-in') {
    stage('Cleanup') { cleanWs() }
}

stage('Report') {
    echo "Done — ${currentBuild.currentResult} ✅"
}

def version = env.VERSION
genStage(title: "Tag ${version}", image: "ubi8", commands: ['git tag v$VERSION'], skipStage: shouldSkip('tag'))

errorStage('Guard', 'this should never run')
skipStage('Skipped on purpose')
notify('SUCCESS')
