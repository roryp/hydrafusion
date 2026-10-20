targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the azd environment. Used to name the resource group and tag resources.')
param environmentName string

@minLength(1)
@description('Azure region for all resources.')
param location string

@description('Container image for the app. azd sets this after the first deploy, so re-provisioning keeps the running image.')
param webImageName string = ''

@secure()
@description('GitHub token with Copilot access for live runs. The preprovision hook takes it from the GitHub CLI. Leave empty to turn live runs off.')
param copilotGitHubToken string = ''

@secure()
@description('Key the dashboard needs before it can start or stop live runs. The preprovision hook makes one.')
param liveRunKey string = ''

@minValue(0)
@description('Most live runs the app starts per UTC day. 0 means no limit.')
param liveRunDailyLimit int = 20

var tags = { 'azd-env-name': environmentName }
var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

module resources 'resources.bicep' = {
  name: 'resources'
  scope: rg
  params: {
    location: location
    tags: tags
    resourceToken: resourceToken
    webImageName: webImageName
    copilotGitHubToken: copilotGitHubToken
    liveRunKey: liveRunKey
    liveRunDailyLimit: liveRunDailyLimit
  }
}

output AZURE_LOCATION string = location
output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = resources.outputs.registryLoginServer
output AZURE_CONTAINER_REGISTRY_NAME string = resources.outputs.registryName
output SERVICE_WEB_NAME string = resources.outputs.webName
output WEB_URL string = resources.outputs.webUrl
// Only says whether a token was given; the token itself never leaves the deployment.
#disable-next-line outputs-should-not-contain-secrets
output LIVE_RUNS_ENABLED bool = !empty(copilotGitHubToken)
