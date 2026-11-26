# Reuse saved lavaan fitted parameters; tighten only R rotation iteration.
suppressPackageStartupMessages({library(jsonlite);library(GPArotation)})
args<-commandArgs(TRUE);out<-args[1];source.dir<-args[2]
hash<-function(file)strsplit(system2("sha256sum",shQuote(file),stdout=TRUE)," ")[[1]][1]
expressions<-parse(file.path(source.dir,"generate.R"))
selected<-Filter(function(e)is.call(e)&&identical(e[[1]],as.name("<-"))&&identical(e[[2]],as.name("rotations")),as.list(expressions))
stopifnot(length(selected)==1);eval(selected[[1]])
for(file in list.files(out,pattern="^[^.]+\\.reference\\.json$",full.names=TRUE)){
  ref<-fromJSON(file,simplifyVector=FALSE)
  for(policy in names(ref$ml))if(ref$ml[[policy]]$status=="ok"){
    A<-do.call(rbind,lapply(ref$ml[[policy]]$unrotatedStandardized,unlist))
    ref$ml[[policy]]$rotations<-rotations(A,TRUE)
    ref$ml[[policy]]$options$rotation<-"none then independent stats/GPArotation with varimax epsilon1e-14 for ML"
  }
  ref$provenance$rotationRefinement<-list(sourceSha256=hash(file.path(source.dir,"refine-ml-rotation.R")),rotationImplementationSha256=hash(file.path(source.dir,"generate.R")),scope="Saved lavaan fit unchanged; only varimax stopping epsilon for ML rotations tightened to1e-14")
  write_json(ref,file,auto_unbox=TRUE,digits=17,na="null",null="null",pretty=TRUE)
}
