properties([[$class: 'BuildDiscarderProperty', strategy: [$class: 'LogRotator', artifactNumToKeepStr: '5', numToKeepStr: '5']]])

node {
    try {
        stage("Checkout") {
            checkout scm
        }
        stage("Install") {
            sh 'npm install'
        }
        stage("Test") {
            sh 'npm run test'
        }
        stage("Build") {
            sh 'npm run build'
        }
        currentBuild.result = "SUCCESS"
    } catch(e) {
        currentBuild.result = "FAILURE"
        throw e
    }
}
