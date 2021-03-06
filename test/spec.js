const chai = require("chai");
const expect = require("chai").expect;
const chaiAsPromised = require("chai-as-promised");
chai.use(chaiAsPromised);

const cacheCdn = require("../index");

const Promise = require("bluebird");
const rimraf = Promise.promisify(require("rimraf"));
const fs = Promise.promisifyAll(require("fs"));
const mkdirp = Promise.promisify(require("mkdirp"));
const fsCopyFile = require("fs-copy-file");

describe("cache cdn", () => {

    // cdn resources
    let jqueryFile = "tmp/js/jquery.min.js";
    let jquery2File = "tmp/js/jquery2.min.js";
    let bootstrapFile = "tmp/css/bootstrap.min.css";

    // test resources
    let testJqueryFile = "test-resources/js/jquery.min.js";
    let testJquery2File = "test-resources/js/jquery2.min.js";
    let testBootstrapFile = "test-resources/css/bootstrap.min.css";
    let badJqueryFile = "test-resources/jquery.bad.min.js";
    let testCdnLockPath = "test-resources/cdn-lock.json";
    let testCdnLockWithExtraEntriesPath = "cdn-lock.extra.entries.json";
    let cdnLockPath = "cdn-lock.json";

    beforeEach(deleteWorkingFiles);

    after(deleteWorkingFiles);

    function deleteWorkingFiles() {
        // delete tmp directory and cdn-lock.json
        return Promise.all([
            rimraf("tmp"),
            rimraf("cdn-lock.json")
        ]);
    }

    it("fails when can't find cdn.json or specified config file", () => {
        let options = { configFile: "cdn.missing.json" };
        return expect(cacheCdn(options)).to.be.rejected;
    });

    it("fails when options.sourceFile is not accompanied by destinationFile", () => {
        let options = { sourceFile: "file.txt" };
        return expect(cacheCdn(options)).to.be.rejected;
    });

    it("fails when options.downloadLibs is not a boolean", () => {
        let options = { downloadLibs: ["my/directory"] };
        return expect(cacheCdn(options)).to.be.rejected;
    });

    it("fails when running with bad config: duplicate filenames: download ON", () => {
        let options = {
            configFile: "test-resources/cdn.dup.filename.json",
            downloadLibs: true
        };
        return expect(cacheCdn(options)).to.be.rejected;
    });

    it("fails when running with bad config: duplicate filenames in different blocks: download ON", () => {
        let options = {
            configFile: "test-resources/cdn.dup.filename.diff.block.json",
            downloadLibs: true
        };
        return expect(cacheCdn(options)).to.be.rejected;
    });

    describe("when running with index.html insertion config", () => {
        let options = {
            downloadLibs: false,
            sourceFile: "app/index.html",
            destinationFile: "tmp/index.html"
        };

        it("adds cdn references to index.html", () => {
            return cacheCdn(options).then(() => {
                return Promise.all([
                    fs.readFileAsync(options.destinationFile, "utf8"),
                    fs.readFileAsync("expected/index.html", "utf8")
                ]).then(([destinationContents, expectedContents]) => {
                    expect(destinationContents).to.equal(expectedContents);
                });
            });
        });
    });

    describe("when running with download OFF", () => {
        let options = {
            downloadLibs: false,
            sourceFile: "app/index.html",
            destinationFile: "tmp/index.html"
        };

        it("does not download cdn references", () => {
            return cacheCdn(options)
                .then(ensureFilesNotFoundLocally);
        });
    });

    describe("when running with download ON", () => {

        describe("and cdn-lock.json has NO entries", () => {
            it("and no files are downloaded - downloads cdn references", () => {
                return cacheCdn().then(ensureFilesExistLocally);
            });

            it("and wrong file is already local - downloads correct file", () => {
                return copyFile(badJqueryFile, jqueryFile)
                    .then(() => cacheCdn())
                    .then(ensureBadJqueryFileOverwritten);
            });
        });

        describe("and cdn-lock.json has entries", () => {
            let cdnLockExistsPromise;

            beforeEach(() => {
                cdnLockExistsPromise = copyFile(testCdnLockPath, cdnLockPath);
            });

            it("removes cdn-lock.json entries which are not in cdn.json", () => {
                return cdnLockExistsPromise
                    .then(() => copyFile(testCdnLockWithExtraEntriesPath, cdnLockPath))
                    .then(() => cacheCdn())
                    // Make sure cdn-lock.json ended up getting normalized
                    .then(() => ensureFilesMatch(cdnLockPath, testCdnLockPath));
            });

            it("but files are not present - downloads cdn references", () => {
                return cdnLockExistsPromise
                    .then(() => cacheCdn())
                    .then(ensureFilesExistLocally);
            });

            it("but local matching filename has wrong contents - downloads correct file", () => {
                return cdnLockExistsPromise
                    .then(() => copyFile(badJqueryFile, jqueryFile))
                    .then(() => cacheCdn())
                    .then(ensureBadJqueryFileOverwritten);
            });

            it("and files are present - does not download cdn references again", () => {
                let jqueryModifiedTime, jquery2ModifiedTime, bootstrapModifiedTime;

                // Setup test data
                return Promise.all([
                    cdnLockExistsPromise,
                    copyFile(testJqueryFile, jqueryFile),
                    copyFile(testJquery2File, jquery2File),
                    copyFile(testBootstrapFile, bootstrapFile)
                ])
                    // Record file modified times
                    .then(() => {
                        return Promise.all([
                            fs.statAsync(jqueryFile).then(stats => jqueryModifiedTime = stats.mtimeMs),
                            fs.statAsync(jquery2File).then(stats => jquery2ModifiedTime = stats.mtimeMs),
                            fs.statAsync(bootstrapFile).then(stats => bootstrapModifiedTime = stats.mtimeMs)
                        ]);
                    })
                    // Run method under test
                    .then(() => cacheCdn())
                    // Validate modified times are unchanged
                    .then(() => {
                        return Promise.all([
                            ensureFileModifiedTimeHasntChanged(jqueryFile, jqueryModifiedTime),
                            ensureFileModifiedTimeHasntChanged(jquery2File, jquery2ModifiedTime),
                            ensureFileModifiedTimeHasntChanged(bootstrapFile, bootstrapModifiedTime)
                        ])
                    });
            });
        });
    });

    function ensureFilesExistLocally() {
        return Promise.all([
            fs.accessAsync(jqueryFile),
            fs.accessAsync(jquery2File),
            fs.accessAsync(bootstrapFile)
        ]);
    }

    function ensureFilesNotFoundLocally() {
        return ensureFilesExistLocally()
            .then(() => expect.fail(null, null, "Cdn files were downloaded (but shouldn't have been because download was turned off)"))
            .catch(err => {
                if (err.code !== "ENOENT") throw err;
            });
    }

    function ensureBadJqueryFileOverwritten() {
        return Promise.all([
            fs.readFileAsync(jqueryFile, "utf8"),
            fs.readFileAsync(badJqueryFile, "utf8")
        ]).then(([jqContents, badJqContents]) => {
            if (jqContents === badJqContents) throw Error("Bad JQuery was not overwritten");
        });
    }

    function ensureFilesMatch(filePath, otherFilePath) {
        return Promise.all([
            fs.readFileAsync(filePath, "utf8"),
            fs.readFileAsync(otherFilePath, "utf8")
        ]).then(([fileContents, otherFileContents]) => {
            if (fileContents !== otherFileContents) throw Error("Files " + filePath + " and " + otherFilePath + " do not match");
        });
    }

    function copyFile(src, dest) {
        return mkdirp(getDirectoryFromFilepath(dest))
            .then(() => {
                return new Promise((resolve, reject) => {
                    fsCopyFile(src, dest, () => {
                        resolve(true);
                    });
                });
            });
    }

    function getDirectoryFromFilepath(filepath) {
        return filepath.substring(0, filepath.lastIndexOf("/"));
    }

    function ensureFileModifiedTimeHasntChanged(filePath, lastModifiedTime) {
        return fs.statAsync(filePath).then(stats => {
            if (lastModifiedTime !== stats.mtimeMs) throw Error("Files were re-downloaded but shouldn't have been");
        });
    }

});