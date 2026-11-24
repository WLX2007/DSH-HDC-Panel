// Scaffolds a minimal, buildable HarmonyOS application so the compile loop
// can be validated on the success path (devecocli build -> .hap artefact
// verification) without touching any real project.
//
// Usage: node scripts/make-sample-app.mjs <targetDir>

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const target = process.argv[2]
if (!target) {
  process.stdout.write('usage: node scripts/make-sample-app.mjs <targetDir>\n')
  process.exit(2)
}

function write(rel, text) {
  const file = join(target, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

write('AppScope/app.json5', `{
  "app": {
    "bundleName": "com.example.dshmcpsample",
    "vendor": "example",
    "versionCode": 1000000,
    "versionName": "1.0.0",
    "icon": "$media:app_icon",
    "label": "$string:app_name"
  }
}
`)

write('AppScope/resources/base/element/string.json', `{
  "string": [
    { "name": "app_name", "value": "DSH MCP Sample" }
  ]
}
`)

write('AppScope/resources/base/media/app_icon.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#2f6fed"/></svg>
`)

write('build-profile.json5', `{
  "app": {
    "signingConfigs": [],
    "products": [
      {
        "name": "default",
        "compileSdkVersion": "26.0.0",
        "compatibleSdkVersion": "26.0.0",
        "targetSdkVersion": "26.0.0",
        "runtimeOS": "HarmonyOS",
        "buildOption": {
          "strictMode": {
            "caseSensitiveCheck": true,
            "useNormalizedOHMUrl": true
          }
        }
      }
    ],
    "buildModeSet": [
      { "name": "debug" },
      { "name": "release" }
    ]
  },
  "modules": [
    {
      "name": "entry",
      "srcPath": "./entry",
      "targets": [
        { "name": "default", "applyToProducts": ["default"] }
      ]
    }
  ]
}
`)

write('entry/build-profile.json5', `{
  "apiType": "stageMode",
  "buildOption": {
    "sourceOption": {
      "workers": []
    }
  },
  "targets": [
    { "name": "default", "runtimeOS": "HarmonyOS" }
  ]
}
`)

write('entry/oh-package.json5', `{
  "modelVersion": "5.0.0",
  "name": "entry",
  "version": "1.0.0",
  "description": "DSH MCP sample entry module",
  "main": "",
  "author": "",
  "license": "MIT",
  "dependencies": {}
}
`)

write('hvigor/hvigor-config.json5', `{
  "modelVersion": "5.0.0",
  "dependencies": {
  },
  "execution": {
  },
  "logging": {
  },
  "debugging": {
  },
  "nodeOptions": {
  }
}
`)

write('hvigorfile.ts', `import { appTasks } from '@ohos/hvigor-ohos-plugin';

export default {
  system: appTasks,
  plugins: []
};
`)

write('entry/hvigorfile.ts', `import { hapTasks } from '@ohos/hvigor-ohos-plugin';

export default {
  system: hapTasks,
  plugins: []
};
`)

write('oh-package.json5', `{
  "modelVersion": "5.0.0",
  "name": "dsh-mcp-sample",
  "version": "1.0.0",
  "description": "DSH MCP sample application",
  "main": "",
  "author": "",
  "license": "MIT",
  "dependencies": {}
}
`)

write('entry/src/main/module.json5', `{
  "module": {
    "name": "entry",
    "type": "entry",
    "description": "$string:module_desc",
    "mainElement": "EntryAbility",
    "deviceTypes": ["phone", "tablet"],
    "deliveryWithInstall": true,
    "installationFree": false,
    "pages": "$profile:main_pages",
    "abilities": [
      {
        "name": "EntryAbility",
        "srcEntry": "./ets/entryability/EntryAbility.ets",
        "description": "$string:EntryAbility_desc",
        "icon": "$media:app_icon",
        "label": "$string:EntryAbility_label",
        "startWindowIcon": "$media:app_icon",
        "startWindowBackground": "$color:start_window_background",
        "exported": true,
        "skills": [
          {
            "entities": ["entity.system.home"],
            "actions": ["action.system.home"]
          }
        ]
      }
    ]
  }
}
`)

write('entry/src/main/resources/base/element/string.json', `{
  "string": [
    { "name": "module_desc", "value": "sample module" },
    { "name": "EntryAbility_desc", "value": "sample ability" },
    { "name": "EntryAbility_label", "value": "DSH MCP Sample" }
  ]
}
`)

write('entry/src/main/resources/base/profile/main_pages.json', `{
  "src": [
    "pages/Index"
  ]
}
`)

write('entry/src/main/resources/base/element/color.json', `{
  "color": [
    { "name": "start_window_background", "value": "#FFFFFF" }
  ]
}
`)

write('entry/src/main/ets/entryability/EntryAbility.ets', `import { UIAbility } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';

export default class EntryAbility extends UIAbility {
  onCreate(): void {
    console.info('DSH MCP sample ability created');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        console.error('loadContent failed: ' + err.code);
      }
    });
  }
}
`)

write('entry/src/main/ets/pages/Index.ets', `@Entry
@Component
struct Index {
  build() {
    Column() {
      Text('Hello HarmonyOS')
        .fontSize(24)
        .fontWeight(FontWeight.Bold)
      Text('Built by the standalone dsh-hdc-mcp server')
        .fontSize(14)
        .margin({ top: 8 })
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }
}
`)

write('entry/src/main/resources/base/media/app_icon.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#2f6fed"/></svg>
`)

process.stdout.write('sample app scaffolded at ' + target + '\n')
