import { chromium, expect } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const out='scripts/efa-reference/compute/runtime-ui-v7';await mkdir(out,{recursive:true});
const table=JSON.parse(await readFile('src/lib/__tests__/fixtures/efa-weighted/normal.input.json','utf8'));
const browser=await chromium.launch({channel:'chrome',headless:true}),errors=[];
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://localhost:3000');await page.waitForFunction(()=>window.__scatterlabBridge?.current);
 await page.evaluate(()=>window.__scatterlabBridge.current.loadDemoData('open'));await page.waitForFunction(()=>window.__scatterlabBridge.current.snapshot().datasets.length>0);
 await page.evaluate(table=>{const bridge=window.__scatterlabBridge.current,s=bridge.snapshot(),first=s.datasets[0];bridge.restore({...s,datasets:[{...first,name:'Synthetic runtime information fixture',table,axes:{x:table.columns[0],y:table.columns[1],z:table.columns[2]},axes2d:{x:table.columns[0],y:table.columns[1]},pcaRuns:[],efa:{runs:[],splits:[]}}],activeId:first.id,pinnedViews:[],analysisViews:[],rowFilter:null,colorBy:'',shapeBy:'',viewMode:'2D'});},table);
 await page.getByRole('button',{name:'EFA',exact:true}).click();await page.getByRole('button',{name:'Select ordinal candidates'}).click();await page.getByLabel('EFA extraction').selectOption('wlsmv');
 await expect(page.getByLabel('MV correction',{exact:true})).toHaveValue('exact');await expect(page.getByRole('radio',{name:'EFA backend cpu',exact:true})).toBeChecked();
 for(const label of ['About MV correction','About Browser CPU','About WebGPU','About Scala']){
  const button=page.getByRole('button',{name:label,exact:true});await button.click();await expect(page.getByRole('tooltip')).toBeVisible();await page.keyboard.press('Escape');await expect(button).toBeFocused();
 }
 await page.getByRole('button',{name:'About WebGPU',exact:true}).click();await expect(page.getByRole('tooltip')).toContainText('does not use random-probe estimation');await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Preview sample',exact:true}).click();await expect(page.getByLabel('Runtime guidance',{exact:true})).toContainText('Exact CPU is a good starting point');
 await page.getByLabel('MV correction',{exact:true}).selectOption('estimated');await expect(page.getByRole('radio',{name:'EFA backend webgpu',exact:true})).toBeChecked();await expect(page.getByRole('radio',{name:'EFA backend cpu',exact:true})).toBeDisabled();await expect(page.getByLabel('Runtime guidance',{exact:true})).not.toBeVisible();
 await page.getByRole('button',{name:'About WebGPU',exact:true}).click();await expect(page.getByRole('tooltip')).toContainText('Estimates the second MV trace');await page.keyboard.press('Escape');
 for(const label of ['About probe count','About probe seed']){const button=page.getByRole('button',{name:label,exact:true});await button.click();await expect(page.getByRole('tooltip')).toBeVisible();await page.keyboard.press('Escape');}
 await page.getByText('Memory and block settings',{exact:true}).click();await expect(page.getByLabel('EFA block rows')).toBeDisabled();
 for(const label of ['About block rows','About inference memory budget']){await page.getByRole('button',{name:label,exact:true}).click();await expect(page.getByRole('tooltip')).toBeVisible();await page.keyboard.press('Escape');}
 await page.getByRole('button',{name:'Preview sample',exact:true}).click();await expect(page.getByText(/WLSMV with estimated MV correction: about/)).toBeVisible();
 await page.getByRole('button',{name:'About runtime guidance',exact:true}).click();await expect(page.getByRole('tooltip')).toContainText('no reliable rows × items accuracy cutoff');await page.keyboard.press('Escape');
 for(const theme of ['primary','terminal']){await page.evaluate(theme=>document.documentElement.setAttribute('data-theme',theme),theme);await page.getByRole('button',{name:'About WebGPU',exact:true}).click();await page.screenshot({path:`${out}/${theme}.png`});await page.keyboard.press('Escape');}
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'About WebGPU',exact:true}).click();const box=await page.getByRole('tooltip').boundingBox();if(!box||box.x<0||box.x+box.width>390||box.y<0||box.y+box.height>844)throw Error('Tooltip outside narrow viewport');await page.screenshot({path:`${out}/mobile.png`});await page.keyboard.press('Escape');
 await page.getByLabel('MV correction',{exact:true}).selectOption('exact');await page.getByRole('radio',{name:'EFA backend scala',exact:true}).check();await expect(page.getByText('Start the companion on this computer, then pair it here.',{exact:false})).toBeVisible();await page.getByRole('radio',{name:'EFA backend cpu',exact:true}).check();
 if(errors.length)throw Error(errors.join('\n'));
 await writeFile(`${out}/report.json`,JSON.stringify({status:'passed',recordedAt:new Date().toISOString(),browser:browser.version(),checks:['exact CPU default','each runtime info button','exact and estimated GPU explanations differ','probe and memory help','Escape focus return','preview-based advice','stale preview hides advice','estimated preview label','CPU and Scala availability restored with exact','both themes','390px tooltip bounds'],errors},null,2)+'\n');console.log('Runtime UI passed');
}catch(error){await writeFile(`${out}/failure.json`,JSON.stringify({status:'failed',error:String(error),errors},null,2));throw error;}finally{await browser.close();}
