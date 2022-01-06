import { spawn } from "child_process";
import { SettingsType, Configuration } from "@yarnpkg/core";
import commandExists = require("command-exists");
import type { Ident, Plugin, Hooks } from "@yarnpkg/core";
import type { Hooks as NpmHooks } from "@yarnpkg/plugin-npm";

const azureDevOpsId = "499b84ac-1321-427f-aa17-267ca6975798";

function run(cmd) {
    return new Promise((resolve, reject) => {
        const task = spawn(cmd, { shell: true, timeout: 3 * 60 * 1000 });
        let result = "";
        task.stdout.on("data", (data) => {
            result += data;
        });
        // out put error or warning to stderr stream
        task.stderr.pipe(process.stderr);
        task.on("error", (err) => {
            console.error(err);
            reject(err);
        });
        task.on("close", (code) => {
            if (code === 0) {
                resolve(result);
            } else {
                reject(new Error(`code: ${code}, ${result}`));
            }
        });
    });
}

function showInstallMessage() {
    console.error("Command `az` not found. Please install Azure CLI first!\n");
    switch (process.platform) {
        case "win32":
            console.warn("⚡ Download this link to install on Windows ⚡");
            console.warn("https://aka.ms/installazurecliwindows");
            break;

        case "darwin":
            console.warn("⚡ Run this script to install Azure CLI on MacOS ⚡");
            console.warn("brew update && brew install azure-cli");
            break;

        default:
            console.warn("⚡ Run this script to install Azure CLI on Linux ⚡");
            console.warn("curl -L https://aka.ms/InstallAzureCli | bash");
            break;
    }
    console.log("\n(How to install the Azure CLI Documents https://docs.microsoft.com/cli/azure/install-azure-cli)");
}

interface TokenType {
    accessToken: string;
    expiresOn: string;
}
let _getAccessTokenPromise: Promise<TokenType>;
function getAccessToken() {
    if (_getAccessTokenPromise) {
        return _getAccessTokenPromise;
    }
    console.log("Refresh Azure DevOps Access Token");
    return (_getAccessTokenPromise = run(`az account get-access-token --resource \"${azureDevOpsId}\"`)
        .catch((error) => {
            console.warn(`Can not get access token for Azure DevOps (${error}).\nTry to login.`);
            return run("az login").then(() => run(`az account get-access-token --resource \"${azureDevOpsId}\"`));
        })
        .then((result: string) => JSON.parse(result) as { accessToken: string; expiresOn: string }));
}

function mapToObj(map: Map<any, any>) {
    const obj = {};
    map.forEach(function (v, k) {
        obj[k] = v instanceof Map ? mapToObj(v) : v;
    });
    return obj;
}

const plugin: Plugin<Hooks & NpmHooks> = {
    configuration: {
        azCliTokenCache: {
            description: `A cache of tokens fetched via azure cli`,
            type: SettingsType.MAP,
            default: new Map(),
            valueDefinition: {
                description: ``,
                type: SettingsType.SHAPE,
                properties: {
                    expiresOn: {
                        description: `An ISO timestamp of when the token expires`,
                        type: SettingsType.STRING as const,
                    },
                    token: {
                        description: `the token`,
                        type: SettingsType.STRING as const,
                    },
                },
            },
        },
    } as any,
    hooks: {
        registerPackageExtensions() {
            if (process.env.SYSTEM_ACCESSTOKEN) {
                return Promise.resolve();
            }
            // This checks to see if the user is logged in before installs even start
            return commandExists("az").then(
                () => { },
                (error) => {
                    showInstallMessage();
                    return Promise.reject(
                        new Error("Azure CLI is required, Make sure the az command is part of your path"),
                    );
                },
            );
        },
        getNpmAuthenticationHeader(
            currentHeader: string | undefined,
            registry: string,
            {
                configuration,
                ident,
            }: {
                configuration: Configuration;
                ident?: Ident;
            },
        ) {
            if (registry.startsWith("https://pkgs.dev.azure.com") || registry.startsWith("http://pkgs.dev.azure.com")) {
                if (process.env.SYSTEM_ACCESSTOKEN) {
                    return Promise.resolve(`Bearer ${process.env.SYSTEM_ACCESSTOKEN}`);
                }
                const azCliTokenCache = configuration.get("azCliTokenCache") as Map<string, Map<string, string>>;

                const expiresOn = new Date(azCliTokenCache.get(registry)?.get("expiresOn"));
                if (+expiresOn - Date.now() > 1000) {
                    return Promise.resolve(`Bearer ${azCliTokenCache.get(registry).get("token")}`);
                }
                return getAccessToken().then((tokenInfo) => {
                    const expiresOn = new Date(tokenInfo.expiresOn).toISOString();
                    const token = tokenInfo.accessToken;
                    azCliTokenCache.set(
                        registry,
                        new Map([
                            ["expiresOn", expiresOn],
                            ["token", token],
                        ]),
                    );
                    return Configuration.updateHomeConfiguration({
                        azCliTokenCache: mapToObj(azCliTokenCache),
                    }).then(() => `Bearer ${token}`);
                });
            }
            return Promise.resolve(null);
        },
    },
};

export default plugin;
