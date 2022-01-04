import { Configuration, Ident, Plugin, SettingsType, Hooks } from '@yarnpkg/core';
import { Hooks as NpmHooks } from '@yarnpkg/plugin-npm'
import { spawn } from 'child_process';
import { DateTime } from 'luxon';

const azureDevOpsId = '499b84ac-1321-427f-aa17-267ca6975798'

function run(cmd) {
    return new Promise((resolve, reject) => {
        const task = spawn(cmd, { shell: true })
        let result = '';
        task.stdout.on('data', (data) => {
            result += data;
        });
        // out put error or warning to stderr stream
        task.stderr.pipe(process.stderr);
        task.on('error', (err) => {
            console.error(err);
            reject(err);
        });
        task.on('close', (code) => {
            if (code === 0) {
                resolve(result);
            } else {
                reject(new Error(`code: ${result}`));
            }
        });
    })
}

function showInstallMessage() {
    console.error("Command `az` not found. Please install Azure CLI first!\n");
    switch (process.platform) {
        case "win32":
            console.error("⚡ Download this link to install on Windows ⚡");
            console.error("https://aka.ms/installazurecliwindows");
            break;

        case "darwin":
            console.error("⚡ Run this script to install Azure CLI on MacOS ⚡");
            console.error("brew update && brew install azure-cli");
            break;

        default:
            console.error("⚡ Run this script to install Azure CLI on Linux ⚡");
            console.error("curl -L https://aka.ms/InstallAzureCli | bash");
            break;
    }
    console.error('\n(How to install the Azure CLI Documents https://docs.microsoft.com/cli/azure/install-azure-cli)')
}
const plugin: Plugin<Hooks & NpmHooks> = {
    configuration: {
        azCliTokenCache: {
            description: `A cache of tokens fetched via azure cli`,
            type: SettingsType.MAP,
            valueDefinition: {
                description: ``,
                type: SettingsType.SHAPE,
                properties: {
                    expiresOn: {
                        description: `An ISO timestamp of when the token expires`,
                        type: SettingsType.STRING as const
                    },
                    token: {
                        description: `the token`,
                        type: SettingsType.STRING as const
                    },
                },
            },
        }
    } as any,
    hooks: {
        registerPackageExtensions() {
            if (process.env.SYSTEM_ACCESSTOKEN) {
                return Promise.resolve()
            }
            // This checks to see if the user is logged in before installs even start
            return run('az account list').then(() => { });
        },
        getNpmAuthenticationHeader(
            currentHeader: string | undefined,
            registry: string, { configuration, ident, }: {
                configuration: Configuration;
                ident?: Ident;
            }) {

            if (registry.startsWith("https://pkgs.dev.azure.com") || registry.startsWith("http://pkgs.dev.azure.com")) {
                if (process.env.SYSTEM_ACCESSTOKEN) {
                    return Promise.resolve(`Bearer ${process.env.SYSTEM_ACCESSTOKEN}`)
                }
                const azCliTokenCache = configuration.get("azCliTokenCache") as {
                    [registry: string]: {
                        expiresOn: string;
                        token: string;
                    } | undefined
                }
                const expiresOn = azCliTokenCache[registry]?.expiresOn && DateTime.fromISO(azCliTokenCache[registry].expiresOn)
                if ((expiresOn?.diffNow("seconds").seconds ?? 0) > 0) {
                    return Promise.resolve(`Bearer ${azCliTokenCache[registry].token}`)
                }
                const getAccessToken = () => run(`az account get-access-token --resource \"${azureDevOpsId}\"`).then((result: string) => {
                    const parsed = JSON.parse(result) as { accessToken: string; expiresOn: string };
                    azCliTokenCache[registry] = {
                        expiresOn: DateTime.fromSQL(parsed.expiresOn).toISO(),
                        token: parsed.accessToken
                    }
                    return Configuration.updateHomeConfiguration({
                        azCliTokenCache
                    }).then(() => `Bearer ${azCliTokenCache[registry].token}`);
                });
                return getAccessToken().catch((error) => {
                    if (error === 127) {
                        // Not found https://www.gnu.org/software/bash/manual/html_node/Exit-Status.html
                        showInstallMessage();
                        return Promise.reject(new Error('Azure CLI is required, Make sure the az command is part of your path'));
                    }
                    console.log('Can not get access token for Azure DevOps, Try to login.');
                    return run('az login').then(getAccessToken);
                });
            }
            return Promise.resolve(null);
        },
    }
};

export default plugin;
