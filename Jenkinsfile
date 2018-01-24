properties([[$class: 'BuildDiscarderProperty', strategy: [$class: 'LogRotator', artifactNumToKeepStr: '5', numToKeepStr: '5']]])

node {
    try {
        stage("Checkout") {
            checkout scm
        }
        stage("Build Info") {
            sh "git rev-parse --short HEAD > git-commit-id"
            writeFile file: 'build-id', text: env.BUILD_NUMBER
        }
        stage("Install") {
            sh 'npm install'
        }
        try {
            stage("Initialize services") {
                sh 'sudo /usr/bin/systemctl start etcd || true'
            }
            stage("Test") {
                sh 'npm run test'
            }
            stage("Build") {
                sh 'npm run build'
            }
            stage("Archive dist") {
                archiveArtifacts artifacts: "git-commit-id, build-id, lib/**/*, package.json, config/default.yaml, node_modules/**/*", fingerprint: false
            }
        } finally {
            sh 'sudo /usr/bin/systemctl stop etcd || true'
        }
        currentBuild.result = "SUCCESS"
    } catch(e) {
        currentBuild.result = "FAILURE"
        throw e
    }
}
