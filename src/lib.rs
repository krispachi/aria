use std::{env, fs};
use zed_extension_api::{self as zed, settings::LspSettings, LanguageServerId, Result};

const PACKAGE: &str = "aria-review-lsp";
const SERVER_PATH: &str = "node_modules/aria-review-lsp/out/server.js";

struct AriaExtension {
    did_find_server: bool,
}

impl AriaExtension {
    fn server_script(&mut self, id: &LanguageServerId) -> Result<String> {
        let exists = fs::metadata(SERVER_PATH).is_ok_and(|stat| stat.is_file());
        if self.did_find_server && exists {
            return Ok(SERVER_PATH.to_string());
        }
        zed::set_language_server_installation_status(
            id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );
        let latest = zed::npm_package_latest_version(PACKAGE);
        match latest {
            Ok(version)
                if zed::npm_package_installed_version(PACKAGE)?.as_deref() != Some(&version)
                    || !exists =>
            {
                zed::set_language_server_installation_status(
                    id,
                    &zed::LanguageServerInstallationStatus::Downloading,
                );
                if let Err(error) = zed::npm_install_package(PACKAGE, &version) {
                    // Keep using an older install when the update fails (e.g. offline).
                    if !fs::metadata(SERVER_PATH).is_ok_and(|stat| stat.is_file()) {
                        return Err(error);
                    }
                }
            }
            Err(error) if !exists => return Err(error),
            _ => {}
        }
        self.did_find_server = true;
        Ok(SERVER_PATH.to_string())
    }
}

impl zed::Extension for AriaExtension {
    fn new() -> Self {
        Self {
            did_find_server: false,
        }
    }

    fn language_server_command(
        &mut self,
        id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let binary = LspSettings::for_worktree(id.as_ref(), worktree)
            .ok()
            .and_then(|settings| settings.binary);
        if let Some(path) = binary.as_ref().and_then(|binary| binary.path.clone()) {
            return Ok(zed::Command {
                command: path,
                args: binary
                    .as_ref()
                    .and_then(|b| b.arguments.clone())
                    .unwrap_or_else(|| vec!["--stdio".into()]),
                env: binary
                    .and_then(|b| b.env)
                    .map(|env| env.into_iter().collect())
                    .unwrap_or_default(),
            });
        }
        if let Some(path) = worktree.which("aria-lsp") {
            return Ok(zed::Command {
                command: path,
                args: vec!["--stdio".into()],
                env: worktree.shell_env(),
            });
        }
        let script = self.server_script(id)?;
        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![
                env::current_dir()
                    .map_err(|error| error.to_string())?
                    .join(script)
                    .to_string_lossy()
                    .into_owned(),
                "--stdio".into(),
            ],
            env: Default::default(),
        })
    }

    fn language_server_initialization_options(
        &mut self,
        id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        Ok(LspSettings::for_worktree(id.as_ref(), worktree)
            .ok()
            .and_then(|settings| settings.initialization_options))
    }

    fn language_server_workspace_configuration(
        &mut self,
        id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        Ok(LspSettings::for_worktree(id.as_ref(), worktree)
            .ok()
            .and_then(|settings| settings.settings))
    }
}

zed::register_extension!(AriaExtension);
