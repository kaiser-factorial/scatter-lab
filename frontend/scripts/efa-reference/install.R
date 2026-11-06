# Development reference only. No R runtime or packages are bundled in the app.
repos <- "https://cloud.r-project.org"
pins <- c(mvtnorm="1.3-3", admisc="0.39", mnormt="2.1.1",
          GPArotation="2025.3-1", psych="2.5.6", polycor="0.8-1", jsonlite="2.0.0")
for (package in names(pins)) {
  version <- pins[[package]]
  archive <- sprintf("%s/src/contrib/Archive/%s/%s_%s.tar.gz", repos, package, package, version)
  current <- sprintf("%s/src/contrib/%s_%s.tar.gz", repos, package, version)
  dest <- tempfile(fileext=".tar.gz")
  ok <- tryCatch({download.file(archive, dest, quiet=TRUE); TRUE}, error=function(e) FALSE)
  if (!ok) download.file(current, dest, quiet=TRUE)
  install.packages(dest, repos=NULL, type="source")
  stopifnot(packageVersion(package) == package_version(version))
}
