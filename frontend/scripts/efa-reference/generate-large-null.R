library(jsonlite)
library(psych)
args<-commandArgs(TRUE)
input<-if(length(args))args[1] else '/out/parallel-large-correlation.json'
output<-if(length(args)>1)args[2] else '/out/parallel-large-r.reference.json'
seed<-if(length(args)>2)as.integer(args[3]) else 8801L
r<-as.matrix(read_json(input,simplifyVector=TRUE))
stopifnot(nrow(r)==500L,ncol(r)==500L)
timing<-system.time(fit<-fa(r,nfactors=1,fm='minres',rotate='none',SMC=TRUE,smooth=FALSE))
loadings<-unclass(fit$loadings)
write_json(list(provenance=list(R=R.version.string,psych=as.character(packageVersion('psych')),inputSha256=strsplit(system2('sha256sum',input,stdout=TRUE),' ')[[1]][1],scope='MINRES extraction from the saved native polychoric matrix; not independent large polychoric estimation',input=paste('500 items, 20000 synthetic respondents; benchmark-data.ts seed 8801; fixed-mask permutation seed',seed),settings=list(nfactors=1,fm='minres',rotate='none',SMC=TRUE,smooth=FALSE)),loadings=loadings,communalities=rowSums(loadings^2),objective=sum((r-loadings%*%t(loadings))[lower.tri(r)]^2),timing=as.numeric(timing)),output,auto_unbox=TRUE,digits=17,pretty=TRUE)
