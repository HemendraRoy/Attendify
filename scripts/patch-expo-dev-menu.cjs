const fs = require('node:fs');
const path = require('node:path');

const devMenuPackage = require.resolve('expo-dev-menu/package.json', {
  paths: [require.resolve('expo-dev-client/package.json')],
});
const uiDir = path.join(path.dirname(devMenuPackage), 'android/src/debug/java/expo/modules/devmenu/compose/ui');

function replaceSection(source, before, after) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) {
    throw new Error('Expo developer menu layout changed. Update the Attendify Tools layout patch.');
  }
  return source.replace(before, after);
}

const screenPath = path.join(uiDir, 'DevMenuScreen.kt');
const toolsPath = path.join(uiDir, 'ToolsSection.kt');
const screen = fs.readFileSync(screenPath, 'utf8');
const tools = fs.readFileSync(toolsPath, 'utf8');

const updatedScreen = replaceSection(screen, `    if (customItems.isNotEmpty()) {
      CustomItemsSection(
        items = customItems,
        onItemClick = { item ->
          onAction(DevMenuAction.TriggerCustomCallback(item))
        }
      )

      Spacer(NewAppTheme.spacing.${'`'}5${'`'})
    }

    ToolsSection(onAction, devToolsSettings, showFab)`,
'    ToolsSection(onAction, devToolsSettings, showFab, customItems)');

const updatedTools = replaceSection(replaceSection(replaceSection(tools,
  'import expo.modules.devmenu.compose.DevMenuActionHandler\n',
  'import expo.modules.devmenu.compose.DevMenuActionHandler\nimport expo.modules.devmenu.compose.DevMenuState\n'),
'  showFab: Boolean\n',
'  showFab: Boolean,\n  customItems: List<DevMenuState.CustomItem>\n'),
`        )
      }
    }
  }
}`, `        )
      }

      customItems.forEach { item ->
        Divider(thickness = 0.5.dp)
        NewMenuButton(
          withSurface = false,
          icon = { MenuIcons.Inspect(size = 20.dp, tint = NewAppTheme.colors.icon.tertiary) },
          content = { NewText(text = item.name) },
          onClick = { onAction(DevMenuAction.TriggerCustomCallback(item)) }
        )
      }
    }
  }
}`);

if (updatedScreen !== screen) fs.writeFileSync(screenPath, updatedScreen);
if (updatedTools !== tools) fs.writeFileSync(toolsPath, updatedTools);
