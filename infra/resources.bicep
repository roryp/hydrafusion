param location string
param tags object

@minLength(13)
@maxLength(13)
param resourceToken string

param webImageName string

@secure()
param copilotGitHubToken string

param liveRunDailyLimit int

var webName = 'ca-web-${resourceToken}'
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

// A public placeholder that listens on 8080 like the app, used until azd deploys the real image.
var placeholderImage = 'mcr.microsoft.com/dotnet/samples:aspnetapp'

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${resourceToken}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'cr${resourceToken}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-web-${resourceToken}'
  location: location
  tags: tags
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, acrPullRoleId)
  scope: registry
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${resourceToken}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

var secrets = empty(copilotGitHubToken) ? [] : [{ name: 'copilot-github-token', value: copilotGitHubToken }]
var secretEnv = empty(copilotGitHubToken) ? [] : [{ name: 'COPILOT_GITHUB_TOKEN', secretRef: 'copilot-github-token' }]

resource web 'Microsoft.App/containerApps@2024-03-01' = {
  name: webName
  location: location
  tags: union(tags, { 'azd-service-name': 'web' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  dependsOn: [acrPull]
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: secrets
    }
    template: {
      containers: [
        {
          name: 'web'
          image: empty(webImageName) ? placeholderImage : webImageName
          // Chrome, the Copilot runtime and Node run side by side.
          resources: {
            cpu: json('2.0')
            memory: '4Gi'
          }
          env: concat([
            { name: 'ALLOWED_HOSTS', value: '${webName}.${environment.properties.defaultDomain}' }
            { name: 'LIVE_RUN_DAILY_LIMIT', value: string(liveRunDailyLimit) }
          ], secretEnv)
        }
      ]
      // Live runs and their events live in memory, so the app runs as exactly one replica.
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

output registryLoginServer string = registry.properties.loginServer
output registryName string = registry.name
output webName string = web.name
output webUrl string = 'https://${web.properties.configuration.ingress.fqdn}'
