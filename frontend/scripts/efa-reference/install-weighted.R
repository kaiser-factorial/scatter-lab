# Archive hashes were obtained from the named CRAN release sources before install.
pins <- jsonlite::fromJSON("/opt/efa/weighted-package-pins.json", simplifyVector=FALSE)
for (package in names(pins)) {
  pin <- pins[[package]]
  filename <- sprintf("%s_%s.tar.gz", package, pin$version)
  urls <- unique(c(pin$sourceUrl,
    sprintf("https://cloud.r-project.org/src/contrib/Archive/%s/%s", package, filename),
    sprintf("https://cloud.r-project.org/src/contrib/%s", filename)))
  dest <- tempfile(fileext=".tar.gz")
  obtained <- FALSE
  for (url in urls) {
    obtained <- tryCatch({download.file(url, dest, quiet=TRUE); TRUE}, error=function(e)FALSE)
    if (obtained) break
  }
  stopifnot(obtained)
  actual <- strsplit(system2("sha256sum", shQuote(dest), stdout=TRUE), " ")[[1]][1]
  stopifnot(identical(actual, pin$sha256))
  install.packages(dest, repos=NULL, type="source")
  stopifnot(packageVersion(package) == package_version(pin$version))
  unlink(dest)
}
packages <- c(names(pins), "MASS", "mnormt", "polycor", "psych", "GPArotation", "jsonlite")
jsonlite::write_json(list(R=R.version.string,
  packages=setNames(lapply(packages,function(p)as.character(packageVersion(p))), packages),
  sourceArchives=pins), "/opt/efa/weighted-installed.json", auto_unbox=TRUE, pretty=TRUE)
