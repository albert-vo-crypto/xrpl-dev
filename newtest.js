`use strict`

const fileSys = require('fs-extra');
const path = require('path')
const Yaml = require('js-yaml');
const logs = require('./log');
const prompt = require('prompt-sync')({sigint: true});
const crypto = require('crypto');
const RippleAPI = require('ripple-lib').RippleAPI;
const { create, globSource } = require('ipfs-core');
const nunjucks = require('nunjucks');
const open = require('open');
const xAddr = require('xrpl-tagged-address-codec')
const Hash = require('ipfs-only-hash')
const qrcode = require('qrcode-terminal');
const figlet = require('figlet');
const inquirer = require('inquirer');
const colorize = require('json-colorizer');
const createTorrent = require('create-torrent')
const parseTorrent = require('parse-torrent');
const AWS = require('aws-sdk');
const pinataSDK = require('@pinata/sdk');
const CID = require('cids')

// Pull in configuration options - setup.yml
let config;
try {
  config = Yaml.load(fileSys.readFileSync('setup.yml', 'utf8'));
} catch (error) {
  // Dies hard this way.. This is a major issue we just fail outright on
  console.log(`Error in index.js: ${error}`);
  process.exit(-1);
}

// Global Things
const xAPI = new RippleAPI({ server: config.xrp.network });
let iAPI;
qrcode.setErrorLevel('H');
// Register plugin
inquirer.registerPrompt('search-list', require('inquirer-search-list'));
let epochCreateTime = Date.now();


// catch and display the errors nicely
function CatchError(err) {
  if (typeof err === 'object') {
    if (err.message) {
      logs.error(err.message)
    }
    if (err.stack) {
      logs.error('StackTrace:')
      logs.error(err.stack);
    }
  } else {
    logs.error('error in CatchError:: argument is not an object');
  }
  prompt('something went wrong, press Enter to exit script...')
  process.exit()
}

//Pin files externally via Pinata Integration
async function UploadBuildFilesPinata(configSettings) {
      try {
        // SDK, we may re write this ourselves -> REST
        let pinata = pinataSDK(config.pinatacloud.accessKey, config.pinatacloud.secretKey);

        //Get the name of the NFT unique build
        let buildFolder = configSettings.buildDestFolder.split(path.sep).pop() 

        // - Some settings to help identify the pin
        const options = {
          pinataMetadata: { name: buildFolder }
        }
        logs.info(`(Pinata Cloud) attempting to pin by hash: ${configSettings.ipfsAddress}`)
        let results = await pinata.pinByHash(configSettings.ipfsAddress, options)

        logs.debug(`(Pinata Cloud) results: ${JSON.stringify(results)}`)

        if (results.status == "searching" || results.status == "prechecking") {
          logs.info('pinata is attempting to pin the hash, validate in the console before exiting script!')
        } else {
          logs.warn('something went wrong during remote pinning, please see logs to resolve')
        }

        return results

      } catch (error) {
        CatchError(error)
      }
}

// Upload files to Web Hosting site (S3 / Spaces)
// - Will need to ensure your permissions are correct!
async function UploadBuildFilesWeb(filePath) {

    try {
      //Setup Endpoint API
      const objectsEndpoint = new AWS.Endpoint(config.webbucket.endpoint);
      const s3 = new AWS.S3({
        endpoint: objectsEndpoint,
        accessKeyId: config.webbucket.accessKeyId,
        secretAccessKey: config.webbucket.secretAccessKey,
        httpOptions: { timeout: config.webbucket.timeout * 60 * 1000 }
      });
  
      //Iterate Over Build Files and Upload them
      // - options specific to globSource
      const globSourceOptions = { recursive: true };
  
      // - Get main folder
      let mainFolder = filePath.split(path.sep).pop() 
  
      for await (const file of globSource(filePath, globSourceOptions)) {
        // - skip if mainFolder
        if (file.path == (path.sep + mainFolder)) {continue}
        
        // - get some filename and path information
        let cleanedFileName = file.path.slice(1)

        //Deal w/ Windows
        if (process.platform === 'win32') {
          let fullFilePath = file.content.path.replace(/\//g, "\\")
        } else {
          let fullFilePath = file.content.path
        }
  
        //Lets upload files
  
        // - Get file content
        let fileContent = fileSys.readFileSync(fullFilePath);
  
        // Setting up S3/Spaces upload parameters
        const params = {
            Bucket: config.webbucket.bucket,
            Key: cleanedFileName,
            Body: fileContent,
            ACL: 'public-read' // Can adjust if you want private
        };
  
        // - Get file stats, warn if large (Over ~ 5 Mb)
        let fileStats = fileSys.statSync(fullFilePath);
        let largeFileUpload = false;
        if (fileStats.size >= 5000000){
          let datSizeMB = (fileStats.size / (1024*1024)).toFixed(2);
          logs.warn(`large file upload in progress ${cleanedFileName} -> ${datSizeMB}MB,  please be patient, switching to sync Upload`)

          // - Do we want to disable the large file sync option?
          if (config.webbucket.disableSyncUpload) {
            logs.warn(`large file upload sync setting disabled for async, see config under webbucket to change`)
          } else{
            largeFileUpload = true
          }

        }

        // Uploading files to the bucket 
        // - options for large file support
        var options = {partSize: 5 * 1024 * 1024, queueSize: 10}; 
        if (largeFileUpload) {
          let status = await s3.upload(params, options).promise();
          logs.info(`File uploaded successfully: ${status.Location}`);
        } else {
          s3.upload(params, options, function(error, status){
            if (error) {CatchError(error) }
              logs.info(`File uploaded successfully: ${status.Location}`);
          })
        }

      }
    } catch (error) {
      CatchError(error)
    }
}

// Write JSON to System State file
async function WriteMetaData(configSettings) {
    try {
      let metaFile = configSettings.buildDestFolder + path.sep + "meta.json";
      logs.info(`writting data to meta file: ${metaFile}`);
      fileSys.writeFileSync(metaFile, JSON.stringify(configSettings.meta, null, 4));
    } catch (error) {
      CatchError(error)
    }
  }

// Write JSON to System State file
async function ValidateFunding(walletAddress) {
    try {
        return new Promise((resolve, reject) => {
            let walletFundedChecking = setInterval(async () => {
                try {
                    await xAPI.getSettings(walletAddress);
                    logs.info(`validating ${walletAddress} is funded...`)
                    clearInterval(walletFundedChecking);
                    resolve()
                } catch (error) {
                    switch(error.data.error){
                        case "NotConnectedError":
                            logs.warn(`reconnecting to XRP Ledger...`);
                            xAPI.connect();
                            break

                        case "actNotFound":
                            logs.debug(`account validation waiting, last check results: ${error.data.error}`)
                            break;

                        default:
                            logs.warn(`encountered error during validation of wallet funding: ${JSON.stringify(error, null, 2)}`)
                            reject()
                            break
                    }
                }
            }, 10000); //Will check every 10 seconds
        });
    } catch (error) {
      CatchError(error)
    }
}

// Upload NFT files to IPFS, returns root string
async function UploadBuildFilesIPFS(configSettings) {
    try {
        logs.info(`if your pushing a large NFT over a slow connection, this may take some time...`)
        //options specific to globSource
        const globSourceOptions = { recursive: true };
        
        //example options to pass to IPFS
        const addOptions = {
            pin: true,
            wrapWithDirectory: true,
            cidVersion: 0, //Reverted back to v0 to save space in Domain field
            timeout: 300000
        };
        let rootFolderCID = "";
        //let includeHead = configSettings.buildDestFolder.split(path.sep).pop();
        for await (const file of iAPI.addAll(globSource(configSettings.buildDestFolder, globSourceOptions), addOptions)) {
            logs.info(`pushing content files: ${file.path} :: ${file.size} :: ${file.cid}`);
            if (!file.path || file.path === "") {
              rootFolderCID = file;
            }
        }

        //Sanity check
        if (rootFolderCID === "") {throw Error("invalid cid returned, empty string")}

        return rootFolderCID
        
    } catch (error) {
        CatchError(error)
    }
}

// Fetch nft-content files cids, returns cids for nft content files
// - Also gathers SHA256 for each file
async function GetNFTFileHashes(contentDirectory) {
  try {
      logs.info(`gathering IPFS CID & SHA256 hashes to add to meta data file...`)
      //options specific to globSource
      const globSourceOptions = { recursive: true };
      
      let cids = [];
      let excludeHead = path.sep + contentDirectory.split(path.sep).pop();
      excludeHead = excludeHead.replace(/\//g,"").replace(/\\/g,"")

      for await (let value of globSource(contentDirectory, globSourceOptions)) {
        if (!value.path.endsWith(excludeHead)) {
          let fileData = await fileSys.readFileSync(value.content.path);
          const cid = await Hash.of(fileData);
          const hash = crypto.createHash('sha256');
          hash.update(fileData);
          const hdigest = hash.digest('hex');
          cids.push({'file':value.path, 'cid': cid, 'sha256': hdigest})
          logs.info(`adding '${value.path}' with cid hash '${hdigest}' to meta data...`)
        }
      }
      return cids
  } catch (error) {
      CatchError(error)
  }
}

// Render the viewer.html file -> index.html
async function RenderViewHTML(configSettings) {
  try {
        let viewerFilePath = configSettings.buildSourceFolder + path.sep + "viewer.html" 
        let indexFilePath = configSettings.buildDestFolder + path.sep + "index.html"
        logs.info(`generating index.html file from ${viewerFilePath}`)
        nunjucks.configure({ autoescape: configSettings.tempateHtmlEscape });

        let htmlPage = await nunjucks.render(viewerFilePath, configSettings);
        fileSys.writeFileSync(indexFilePath, htmlPage);
        logs.info(`index.html file generated: ${indexFilePath}`)

        let preview;
        do {
          let resp = prompt("Would you like to preview the NFT index.html page [ y/n ] ")
          switch(resp){
            case "y":
              // attempts to launch users browser, best if user has Brave Browser
              await open(indexFilePath)
              preview = true
              break
            case "n":
                preview = true
                break
            default:
              logs.warn(`invalid option given: '${resp}' use Ctrl+C to exit if required, otherwise try again...`)
              break
          }
        } while (!preview);

        return
  } catch (error) {
      CatchError(error)
  }
}

// Update xrp wallet data
async function updateXRPWalletData(walletData, walletAddress) {
    try {
        //Get some account info
        // - Fee calculation
        let fee = await xAPI.getFee();
        fee = (parseFloat(fee) * 1000000).toFixed(0) + "";
        // Seq calculation
        let accInfo = await xAPI.getAccountInfo(walletAddress.address);
        let seqNum = accInfo.sequence;

        // TX Template for update
        let tempWalletData = {
            "TransactionType": "AccountSet",
            "Account" : walletAddress.address,
            "Fee": fee,
            "Sequence": seqNum,
            "SetFlag": 5
        }

        //Merge options with template
        let txWallet = {...tempWalletData, ...walletData};

        //Prepare TX for sending to ledger
        let txJSON = JSON.stringify(txWallet);
        let signedTX = xAPI.sign(txJSON, walletAddress.secret);

        //Submit the signed transaction to the ledger (need to add validation here)
        await xAPI.submit(signedTX.signedTransaction).then(function(tx){
            logs.debug(`attempting submition of transaction: ${txJSON}`);
            logs.debug(`tentative message: ${tx.resultMessage}`);
            logs.info(`tx status code: ${tx.resultCode} , tx hash ${tx.tx_json.hash}`);
          }).catch(function(e){
            logs.warn(`tran failure to send data: ${e}`);
          });
    } catch (error) {
        CatchError(error)
    }
}

// Get working build directory and settings
// - Return build settings and path information for selection
async function GetBuildConfig() {
  try {
      //options specific to globSource
      const globSourceOptions = { recursive: true };
      let workOptions = [];
      //look for all build directories
      let inputDir = __dirname + path.sep + 'input';
      for await (const file of globSource(inputDir, globSourceOptions)) {
        let pathCount = file.path.split("/").length-1;
        if (pathCount < 3 && pathCount > 1) {
          file.path = __dirname + file.path;
          //Deal w/ Windows
          if (process.platform === 'win32') {
            file.path = file.path.replace(/\//g, "\\")
          }
          workOptions.push(file);
        }
      }

      //sanity check
      if (!workOptions) {throw Error("no valid build directories found in input directory, exiting")}

      // ask which directory we would like to build from
      let buildDir = await inquirer.prompt([
          {
              type: "search-list",
              message: "Select NFT build folder to use, located under the input directory...",
              name: "buildSourceFolder",
              choices: workOptions.map(dirs => ({name: dirs.path})),
          }  
      ]);

      // Get the make.yml settings for use during the build
      let buildConfigPath = buildDir.buildSourceFolder + path.sep + "make.yml";
      let buildConfig = await Yaml.load(fileSys.readFileSync(buildConfigPath, 'utf8'));

      //Calculate the destination build directory
      // NFT Name + epoch => foldername (lowercase, no spaces) 
      let destName = buildDir.buildSourceFolder.split(path.sep).pop().toLowerCase().replace(/\s/g, '') + `${epochCreateTime}`;
      let buildDestFolder = __dirname + path.sep + 'output' + path.sep + destName

      //Return the results
      return {...buildConfig.settings, ...{"buildSourceFolder": buildDir.buildSourceFolder, "buildDestFolder": buildDestFolder}}

  } catch (error) {
      CatchError(error)
  }
}

// Get or Create XRP Address
// - convert this to inquire later...
async function GetXRPWalletAddress() {
    try {      
      // - (options) Use existing address seed OR create a new wallet address
      let address = {};
      let secret;
      let validAcc = false;
      do {
        let resp = prompt("Would you like to supply your own account seed? Ex: snfFLJ95fJr3e.... [ y/n ] ")
        switch(resp){
          case "y":
            secret = prompt("please enter your secret: ")
            if (await xAPI.isValidSecret(secret)) {
              let tempAddr = await xAPI.deriveKeypair(secret);
              address.address = await xAPI.deriveAddress(tempAddr.publicKey)
              address.xAddress = await xAddr.Encode({ account: address.address})
              address.secret = secret
              logs.info(`account secret appears valid: '${secret}'`)
              validAcc = true;
              break
            } else {
              logs.warn(`the provided secret was not valid, please try again: '${secret}'`)
              break
            }
          case "n":
              logs.info(`generating a new wallet address...`)
              address = await xAPI.generateAddress();
              validAcc = true;
              break
          default:
            logs.warn(`invalid option given: '${resp}' use Ctrl+C to exit if required, otherwise try again...`)
            break
        }
      } while(!validAcc);

      //return the results
      return address

    } catch (error) {
      CatchError(error)
    }
}

// Write Torrent tracker file .torrent
// - Must be seeded by user, WebTorrent and or Desktop client
async function BuildTorrentTracker(configSettings) {
  return new Promise((resolve,reject) => {
    try {
      //NFT Name
      let nftName = configSettings.buildDestFolder.split(path.sep).pop()

      //Build out the torrent file name
      let torFileName = nftName + ".torrent"
      
      //Torrent Options
      let torrentOptions = {
        name: nftName,
        comment: "xnft:" + configSettings.meta.details.NFTWalletXAddress
      }

      // Add webseed if webbucket is enabled
      // - This might be the base bucket name before DNS for the webHostingURI above
      // - Helps bypass initial seeding slow downs from CDN propigation delays
      if (config.webbucket.enabled) {
        let bucketName = config.webbucket.bucket;
        let endpoint = config.webbucket.endpoint;
        if (torrentOptions.urlList == null) {torrentOptions.urlList = []}
        let urlName = `https://${bucketName}.${endpoint}/`;
        logs.info(`adding webseed to base web bucket location: ${urlName}`)
        torrentOptions.urlList.push(urlName)
      }

      // Add webseed if webHostingURI is present (It should be)
      if (configSettings.meta.webHostingURI) {
        logs.info(`adding webseed to torrent file: https://${configSettings.meta.webHostingURI}`)
        if (torrentOptions.urlList == null) {torrentOptions.urlList = []}
        torrentOptions.urlList.push(`https://${configSettings.meta.webHostingURI}/`)
      }

      //If useIPFSWebSeed is true, add it as well
      if (configSettings.useIPFSWebSeed) {
        if (torrentOptions.urlList == null) {torrentOptions.urlList = []}
        // - convert v0 to v1 IPFS hash
        let cidv0 = new CID(configSettings.ipfsAddress)
        let cidv1 = cidv0.toV1()

        // - Move these to the config file in the future, redo this
        logs.info('adding IPFS urls to torrent webseed list')
        
        torrentOptions.urlList.push(`https://gateway.ipfs.io/ipfs/${configSettings.ipfsAddress}/`)
        torrentOptions.urlList.push(`https://${cidv1}.ipfs.dweb.link/`) //Requires v1
        torrentOptions.urlList.push(`https://ipfs.io/ipfs/${configSettings.ipfsAddress}/`)
        torrentOptions.urlList.push(`http://${cidv1}.ipfs.localhost:8080/`) //If your running a local IPFS node, will help pull files faster
        logs.info(`added IPFS urls to torrent webseed profile: ${JSON.stringify(torrentOptions.urlList, null, 2)}`)
      }

      // Add a webseed for pinata cloud IPFS if using pinata remote pinning services
      if (config.pinatacloud.enabled) {
        if (torrentOptions.urlList == null) {torrentOptions.urlList = []}
        let pinataName = `https://gateway.pinata.cloud/ipfs/${configSettings.ipfsAddress}/`
        logs.info(`adding pinata cloud webseed as pintacloud is enabled: ${pinataName}`)
        torrentOptions.urlList.push(pinataName)
      }
      
      //Build the torrent file
      createTorrent(configSettings.buildDestFolder, torrentOptions, async (error, torrent) => {
        if (error) {CatchError(error)}
        // `torrent` is a Buffer with the contents of the new .torrent file
        
        // Write to Src Dir, then move to Dest after creation
        let creationPath = configSettings.buildSourceFolder + path.sep + torFileName
        await fileSys.writeFile(creationPath, torrent)
        let torData = parseTorrent(torrent)

        //Move the file to the build directory
        let movePath = configSettings.buildDestFolder + path.sep + torFileName
        logs.info(`moving torrent file from ${creationPath} to ${movePath}`)
        await fileSys.move(creationPath, movePath)
        logs.info('file copy completed')

        //Return the infoHash for the Torrent file
        logs.info(`torrent hash: ${torData.infoHash}`)
        resolve(torData.infoHash)
      })
    } catch (error) {
      CatchError(error)
      reject(error)
    }

  });
}


// Build Domain Field Pointer information
async function BuildDomainPointer(resources) {
  /* 
      Example
      @xnft:
      btih:1e3ec2d9d231b7dbe0b0ba2db911cb97eadd40bb
      ipfs:Qmct4KDxLbpXTgpKPXYv6enj4yRBCNkxtfAEWP9jFqLtkW
      ilpd:$ilp.uphold.com/ZQ9a44qFAxLk
      http:nft.xrpfs.com
      
      157 bytes of 256 MAX
      OR
      @xnft:meta.json
      btih:1e3ec2d9d231b7dbe0b0ba2db911cb97eadd40bb
      ipfs:Qmct4KDxLbpXTgpKPXYv6enj4yRBCNkxtfAEWP9jFqLtkW
      ilpd:$ilp.uphold.com/ZQ9a44qFAxLk
      http:nft.xrpfs.com
      
      166 bytes of 256 MAX
      -------------------------------------------------------------------------------------------------------------
      @[xnft]: <- Defines this group of resources is a XRP NFT resource group | meta.json <- additional data (opt.)
      [btih]:[Torrent Hash Address]
      [ipfs]:[IPFS Data]
      [ilpd]:[Dynamic ILP pointer, overrides defined meta pointer data]
      [http]:[Domain hosting data (base url)]
      [service identification]::
      [protocal]:[resource address / instruction] (pointers)
      Must be less then 256 Chars / bytes
      NewLine sep
      resources -> k/v Obj {"protocol" : "resource address / instruction", "protocol" : "resource address / instruction", ...}
      Max 256 data, will fail if over!
  */
  try {
    //Build the domain value out
    let domainValue = "";
    domainValue += "@xnft:\n";
    //Add the protos and resources
    // - Add size validation here, add as much as possible, then warn on failed additions / rev2
    Object.entries(resources).forEach(([key, value]) => {
      domainValue += `${key}:${value}\n`
    });

    //Validate the size of the output does not exceed byte limit
    let bufSize = Buffer.from(domainValue).length
    if (bufSize > 256) {
      throw Error(`Domain value exceeds max value of 256, ${bufSize}`)
    }
    //Some Logging
    logs.info(`Domain value: \n${domainValue}Value size: ${bufSize} of 256 bytes used`)

    //Convert for use in Domain Account set
    let hexDomValue = new Buffer.from(domainValue).toString('hex').toUpperCase();
    logs.info(`Domain value in hex: ${hexDomValue}`)
    return hexDomValue

  } catch (error) {
    CatchError(error)
  }
}

//Main execution block for script
async function main() {
    try {
        process.stdout.write('\033c')
        let output = figlet.textSync('Xrpl  NFT  Creator', {
          font: 'Small',
          horizontalLayout: 'default',
          verticalLayout: 'default',
          width: 120,
          whitespaceBreak: false
        });
        console.log(output)

        // Init IPFS
        logs.info('starting IPFS node for content distribution')

        // - Testing, seems updated IPFS package has some bugs
        iAPI = await create({ 
            repo: config.ipfs.node
          });

        // Statements to end user on usage of script
        logs.warn("DO NOT USE THIS IN PRODUCTION, THIS IS A Proof Of Concept")
        logs.warn("Use the XRP TestNet for testing")
        logs.warn("You can get a XRP Test account here: https://xrpl.org/xrp-testnet-faucet.html")
        prompt("By pressing enter, you agree and understand this is a Proof of Concept, and SHOULD NOT be used for production!")

        // Choose the build path to use and get the build config
        let buildSettings = await GetBuildConfig()

        //Confirm the settings being used for this build with a confirmation
        console.log(colorize(JSON.stringify(buildSettings, null, 2)))
        let validBuildSettings = await inquirer.prompt([
          {
              type: "confirm",
              message: "Does the configuration appear valid, would you like to continue the build...",
              name: "valid",
              choices: ["y", "n"]
          }  
        ]);
        if (!validBuildSettings.valid) {
          logs.warn("aborting build due to bad build settings")
          process.exit()
        } else {
          logs.info(`user validated build settings for ${buildSettings.buildDestFolder}`)
        }

        //Create the build folder and copy the NFT contents for building
        !fileSys.existsSync(buildSettings.buildDestFolder) && fileSys.mkdirSync(buildSettings.buildDestFolder);
        logs.info(`created build destination: '${buildSettings.buildDestFolder}'`)
        logs.info(`copying date from source '${buildSettings.buildSourceFolder + path.sep + buildSettings.contentFolder}' to '${buildSettings.buildDestFolder}'`)
        await fileSys.copy(buildSettings.buildSourceFolder + path.sep + buildSettings.contentFolder, buildSettings.buildDestFolder)
        logs.info('file copy completed')
        logs.info()

        // Get additional meta of nft content folder
        // - Content IDentifiers for IPFS and SHA256 values for files
        buildSettings.meta.hashes = await GetNFTFileHashes(buildSettings.buildDestFolder)

        // Setup a new XRP wallet ( MUST BE PRE-FUNDED w/ 20 xrp + Account Set Fee)
        // Starts the XRP Ledger API interface
        logs.info(`Init connection to xrp ledger: ${JSON.stringify(config.xrp.network, null, 4)}`);
        await xAPI.connect();

        // Generate NFT wallet address to be funded by author address
        let address = await GetXRPWalletAddress()

        // Display the account for the user
        logs.info(`NFT Wallet Address: (Classic)  '${address.address}'`)
        qrcode.generate(address.address, {small: true}, function(qrcode){
          logs.info(`Classic Address QR Code\n${qrcode}\n\n\n`)
        });
        logs.warn(`NFT Wallet Secret:  ${address.secret}  <-- This value is logged!`);
        qrcode.generate(address.address, {small: true}, function(qrcode){
          logs.info(`Address Secret QR Code\n${qrcode}\n\n\n`)
        });
        logs.info()

        // Add the public wallet address to the meta data
        buildSettings.meta.details.NFTWalletAddress = address.address.toString()
        buildSettings.meta.details.NFTWalletXAddress = address.xAddress.toString()

        // - Write Meta data to nft-content folder for IPFS packaging
        buildSettings.meta.created = epochCreateTime;
        buildSettings.meta.framework = "https://github.com/calvincs/xrpl-nft-creator";
        await WriteMetaData(buildSettings);

        // - Render view.html file to index.html file in build output dir
        // - validate its output
        await RenderViewHTML(buildSettings);

        // - Before push content and fund the account, lets validate the data
        logs.warn(`PLEASE VALIDATE DATA BEFORE Deployment and Account Funding`)
        console.log(colorize(JSON.stringify(buildSettings, null, 2)))
        validBuildSettings = await inquirer.prompt([
          {
              type: "confirm",
              message: "Does the configuration appear valid...",
              name: "valid",
              choices: ["y", "n"]
          }  
        ]);
        if (!validBuildSettings.valid) {
          logs.warn("user aborting build")
          process.exit()
        } else {
          logs.info(`user validated build settings for ${buildSettings.buildDestFolder}`)
        }
        logs.info()

        //Lets bundle up the files in IPFS
        // - Push content build files to IPFS w/ PIN, get CID value
        let online = await iAPI.isOnline();
        logs.info(`IPFS Online status: ${online}`);
        let cidData = await UploadBuildFilesIPFS(buildSettings);

        let baseString = cidData.cid.toString();

        let baseStringURL = `ipfs://${baseString}/`;
        buildSettings.ipfsAddress = baseString;
        logs.info(`(IPFS) content base string recorded as: ${baseStringURL}`);
        
        /*
          We should start to pin before we build torrent
          We need to build torrent AFTER IPFS if using IPFS trackers
          We need to build torrent BEFORE Web push, if hosting on domain (ensure bucket has .tor file)
        */
        //0. Are we using Pinata Cloud for remote pinning?
        if (config.pinatacloud.enabled) {
          logs.info(`pinata cloud hosting enabled, attempting to pin hash '${buildSettings.ipfsAddress}' files`)
          await UploadBuildFilesPinata(buildSettings)
        }

        //1. Are we also creating a Torrent Package?
        logs.info(`(Torrent) build file set to: ${buildSettings.makeTorrent}`)
        let btHash = false
        if (buildSettings.makeTorrent) {
          btHash = await BuildTorrentTracker(buildSettings)
        }

        //2. Push webseed if used (S3-AWS/Spaces-DigitialOcean)
        // - See if we should push to a remove bucket for hosting
        if (config.webbucket.enabled) {
          logs.info(`web hosting enabled, attempting to upload '${buildSettings.buildDestFolder}' files`)
          await UploadBuildFilesWeb(buildSettings.buildDestFolder)
        }
        logs.info()
        
        // You MUST FUND THE NEW ADDRESS NOW for this to work
        // Validating the address is funded...
        logs.warn(`YOU MUST FUND THE NFT ADDRESS w/ 20+ XRP (CLASSIC): '${address.address.toString()}' (XADDRESS): '${address.xAddress.toString()}'`)
        logs.info(`Waiting for wallet funding to complete, will check every 10 seconds till validated...`)
        await ValidateFunding(address.address)
        logs.warn(`validation completed, wallet ${address.address} is funded`)

        //Get string ready for XRPL Wallet Domain Field
        // - Build the Domain Resource Pointer
        let resources = {}
        if (btHash) { resources.bith = btHash}
        if (baseString) {resources.ipfs = baseString}
        if (buildSettings.meta.webHostingURI) {resources.http = buildSettings.meta.webHostingURI}
        if (buildSettings.meta.staticILPAddress) {resources.ilpd = buildSettings.meta.staticILPAddress}
        // - Build it
        let xrpDomainField = await BuildDomainPointer(resources)
        logs.info(`Attempting to set ${address.address} Domain field with resource settings...`)
        // Write the data to the NFT Wallet
        await updateXRPWalletData({"Domain": xrpDomainField}, address)

        // IPFS Hosting
        // You should pin this remotely, display some messages for user
        logs.info("Content is best viewed with an IPFS enabled browser, like Brave Browser: https://brave.com/")
        logs.info(`Validate your NFT data is live (IPFS)(Base Dir): ${baseStringURL}`)
        logs.info(`Validate your NFT base folder is live: https://gateway.ipfs.io/ipfs/${baseString} `)
        logs.info()
        logs.warn('Your data is being served from this temp IPFS node currently')
        logs.info('Note: You can use IPFS desktop to pin this content over IPFS after thie script ends')
        logs.info('YOU MUST PIN the base directory CID')
        logs.info(' - If you do this however, ensure the .torrent file is removed BEFORE you upload the folder and pin')
        logs.info(' - validate the IPFS CID after the folder upload on IPFS desktop to ensure it matches')
        if (config.pinatacloud.enabled) {
          
          logs.info('Pinata cloud was found, and is in the process of externally pinning your data, please validate on their site')
          logs.warn('You may want to still consider running your own IPFS node: https://ipfs.io/')
          logs.warn('You need to ensure this script is alive untill your IPFS data is pinned externally')
        } else {
          logs.warn('you should PIN this NFT externally for long term distribution')
          logs.info('Pinning Service: https://pinata.cloud/ Or run your own IPFS node: https://ipfs.io/')
          logs.warn('This node application will end at some point, this will stop the IPFS node and close the XRP ledger connections')
          logs.warn('when this node ends, if your IPFS data is not externally available, no one will be able to reach it via IPFS')
        }
        logs.info()
        // HTTP Hosting
        if (config.webbucket.enabled) {
          logs.info(`you also created a webseed/web hosted version of this item, you should validate it is hosted properly`)
          logs.info(`bucket endpoint -> '${config.webbucket.endpoint}`)
          logs.info(`bucket set to resolve to -> '${buildSettings.meta.webHostingURI}'`)
        }
        logs.info()
        // Torrent Hosting
        if (buildSettings.makeTorrent) {
          logs.info(`you also created a torrent package of this item, you should begin seeding this package`)
          logs.info(`the torrent file with hash id of '${btHash}' is located in your output build directory`)
          logs.info(`you MUST used a webtorrent client for webtorrent seeding, otherwise webtorrent clients will not see torrent!`)
          logs.warn(`you are responsible for maintaining your torrent seeding of said content!`)
        }
        logs.info()
        // XRP Account Information & other details
        logs.info(`See your Testnet NFT wallet here: https://testnet.xrpl.org/accounts/${address.address}`)
        logs.warn(`Remember this activity was all logged to xrpl-nft-creator.log, and contains your secrets during this minting session!`)
        logs.warn('Use Ctrl+C to end the program')
        logs.info('Will show IPFS swarm data every 60 seconds till script is closed')
        logs.info()
        // Show number of swarm peers for IPFS
        let peerHealthCheck = setInterval(async () => {
          try {
              if (iAPI.isOnline() == false) {
                  clearInterval(peerHealthCheck);
                  logs.info('ipfs node is no longer online, stopping peer health check')
              } else {
                  const peers = await iAPI.swarm.peers()
                  logs.debug(`this IPFS node now has ${peers.length} swarm peers...`)
              }
          } catch (error) {
              CatchError('An error occurred trying to check our peer counts:', error)
          }
      }, 60000); //Every 60 seconds, check swarm count

      //Final Disconnect after wait, if enabled 
      if (config.system.exitEnabled) {
        logs.warn(`Script is set to end in ${config.system.exitScriptTTL} minutes`)
        setTimeout(async function(){
          logs.info('Time to close things down...')
          await xAPI.disconnect()
          await iAPI.stop();
          process.exit()
        }, config.system.exitScriptTTL * 60 * 1000);
      }

    } catch (error) {
        CatchError(error)
        process.exit(-1)
    }
}

main()