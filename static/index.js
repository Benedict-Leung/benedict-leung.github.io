$(document).ready(function() {   
    var radius = 8;
    TweenMax.staggerFromTo('.blob', 4 ,{
      cycle: {
        attr:function(i) {
          var r = i*90;
          return {
            transform:'rotate('+r+') translate('+radius+',0.1) rotate('+(-r)+')'
          }      
        }
      }  
    },{
      cycle: {
        attr:function(i) {
          var r = i*90+360;
          return {
            transform:'rotate('+r+') translate('+radius+',0.1) rotate('+(-r)+')'
          }      
        }
      },
      ease:Linear.easeNone,
      repeat:-1
    });

    let previousPanel = 0;
    let currentPanel = 0;
    let run = false;

    function resetHR() {
        $("hr").animate({
            width: "25%"
        }, {
            duration: 100
        });

        $(".panel-title").stop();
        $(".panel-title").animate({
            left: "-50%",
            opacity: "0"
        }, {
            duration: 800
        });

        $(".text-container").stop();
        $(".text-container").animate({
            left: "25%",
            opacity: "0"
        }, {
            duration: 800
        });
    }

    function activateHR() {
        if (previousPanel != currentPanel) {
            resetHR();
            let names = ["welcome", "about", "skills", "projects"];
    
            $("hr." + names[currentPanel] + "Button").animate({
                width: "50%"
            }, {
                duration: 100
            });
            previousPanel = currentPanel;

            $("." + names[currentPanel] + " .panel-title").stop();
            $("." + names[currentPanel] + " .text-container").stop();

            $("." + names[currentPanel] + " .panel-title").animate({
                left: "0",
                opacity: "1"
            }, {
                duration: 800
            });

            $("." + names[currentPanel] + " .text-container").delay(800).animate({
                left: "50%",
                opacity: "1"
            }, {
                duration: 800
            });
        }
    }

    $(".welcomeButton").click(() => {
        currentPanel = 0;
        activateHR();

        $(".container").animate({
            scrollTop: 0
        }, {
            duration: 100
        });
    });

    $(".aboutButton").add("#learn").click(() => {
        currentPanel = 1;
        activateHR();
        
        $(".container").animate({
            scrollTop: window.innerHeight
        }, {
            duration: 100
        });
    });

    $(".skillsButton").click(() => {
        currentPanel = 2;
        activateHR();
        
        $(".container").animate({
            scrollTop: window.innerHeight * 2
        }, {
            duration: 100
        });
    });

    $(".projectsButton").click(() => {
        currentPanel = 3;
        activateHR();
        
        $(".container").animate({
            scrollTop: window.innerHeight * 3
        }, {
            duration: 100
        });
    });
    

    $(".container").on("mousewheel touchmove",
        function(e) {
            e.preventDefault();
            if (!run) {
                if (e.originalEvent.deltaY > 0) {
                    currentPanel = Math.min(3, currentPanel + 1);
                } else {
                    currentPanel = Math.max(0, currentPanel - 1);
                }
                activateHR();

                run = true;
                $(".container").animate({
                    scrollTop: currentPanel * window.innerHeight
                }, {
                    duration: 100,
                    complete: function() {
                        setTimeout(() => run = false, 700);
                    }                
                });
            }
        }
    );
});