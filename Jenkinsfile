properties([[$class: 'BuildDiscarderProperty', strategy: [$class: 'LogRotator', artifactNumToKeepStr: '5', numToKeepStr: '5']]])

node {
    try {
        stage("Checkout") {
            checkout scm
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
        } finally {
            sh 'sudo /usr/bin/systemctl stop etcd || true'
        }
        currentBuild.result = "SUCCESS"
    } catch(e) {
        currentBuild.result = "FAILURE"
        throw e
    }
}
